import { CLUB } from './club-config.js';
import {
  admin, loadCustomer, saveCustomer, ensureJoined, safeTags, withRetry,
  createStampGift, revokeCodeIfUnused, REF_PATTERN, migrate
} from './club.js';

export { migrate };

/*
 * Avelyn Club — rapprochement d'une commande avec ce que le club a crédité.
 *
 * Un seul chemin pour tous les événements Shopify (orders/paid, /fulfilled,
 * /updated, /cancelled, refunds/create) et pour le rattrapage quotidien : on
 * relit la commande, on calcule ce qu'elle DOIT rapporter, on compare au
 * registre de la cliente (métachamp loyalty.orders) et on applique l'écart.
 * Rejouer un événement, le recevoir en double ou dans le désordre ne change
 * donc rien — et une commande ratée par un webhook est rattrapée au suivant.
 *
 * Règles :
 * - une commande rapporte quand elle est payée ET expédiée en entier ;
 *   points = euros entiers du sous-total (après remises, hors livraison et
 *   hors cartes cadeaux) × barème ; tampon si ce montant ≥ minSubtotal
 * - remboursement, annulation, article retiré : l'écart est repris (le
 *   solde peut passer sous zéro si les points ont déjà été échangés)
 * - pièce offerte : une par tranche complète de `goal` tampons ; si un
 *   tampon disparaît, la dernière pièce non utilisée est retirée, une pièce
 *   déjà utilisée n'est pas redonnée par la carte suivante
 * - parrainage : à la première commande de la filleule (sa plus ancienne non
 *   annulée), dès minSubtotal ; repris si elle passe sous ce seuil
 */

const ORDER_QUERY = `query($id: ID!) { order(id: $id) {
  id name createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus discountCodes
  currentSubtotalPriceSet { shopMoney { amount } }
  lineItems(first: 100) { nodes { isGiftCard currentQuantity discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } } } }
  customAttributes { key value }
  shippingAddress { address1 zip }
  customer { id }
} }`;

export const PAID = ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'];

/** Montant qui compte pour le club : sous-total moins les cartes cadeaux. */
export function orderBase(order) {
  const subtotal = Number(order.currentSubtotalPriceSet?.shopMoney?.amount) || 0;
  const giftCards = (order.lineItems?.nodes || [])
    .filter((l) => l.isGiftCard)
    .reduce((sum, l) => sum + (Number(l.discountedUnitPriceAfterAllDiscountsSet?.shopMoney?.amount) || 0) * (l.currentQuantity || 0), 0);
  return Math.max(0, subtotal - giftCards);
}

const today = () => new Date().toISOString().slice(0, 10);

function countStamps(c) {
  c.stamps = (c.actions.legacyStamps || 0) + Object.values(c.ledger).reduce((n, e) => n + (e.s ? 1 : 0), 0);
}

function refreshRewardCode(c) {
  const open = [...c.actions.gifts].reverse().find((g) => g.code && !g.used);
  c.rewardCode = open ? open.code : '';
}

/** Autant de pièces que de cartes complètes ; la dernière non utilisée est retirée sinon. */
async function reconcileGifts(c, orderName) {
  countStamps(c);
  const due = Math.floor(c.stamps / CLUB.stamps.goal);
  let note = '';
  while (c.actions.gifts.length < due) {
    const code = `AV-GIFT-${orderName.replace(/\D/g, '')}${c.actions.gifts.some((g) => g.code.startsWith(`AV-GIFT-${orderName.replace(/\D/g, '')}`)) ? `-${c.actions.gifts.length + 1}` : ''}`;
    await createStampGift(c.id, code);
    c.actions.gifts.push({ code });
    note = ' — pièce offerte';
  }
  while (c.actions.gifts.length > due) {
    const last = c.actions.gifts.at(-1);
    const outcome = last.used || !last.code ? 'used' : await revokeCodeIfUnused(last.code);
    if (outcome === 'used') { last.used = last.used || 'oui'; break; }
    c.actions.gifts.pop();
    note = ' — pièce offerte retirée';
  }
  refreshRewardCode(c);
  return note;
}

function sameAddress(a, b) {
  const norm = (x) => `${x?.address1 || ''}|${x?.zip || ''}`.toLowerCase().replace(/[^a-z0-9|]/g, '');
  return Boolean(a?.address1 && b?.address1) && norm(a) === norm(b);
}

/** Parrainage : renvoie l'id de la marraine retenue, ou null (et des tags à poser). */
async function findSponsor(c, order, tags) {
  const ref = ((order.customAttributes || []).find((a) => a.key === '_club_ref')?.value || '').trim().toUpperCase();
  if (!REF_PATTERN.test(ref) || ref === c.ref) return null;
  const first = await admin(
    `query($id: ID!) { customer(id: $id) { orders(first: 10, sortKey: CREATED_AT) { nodes { id cancelledAt } } } }`,
    { id: c.id }
  );
  const oldest = first.customer?.orders?.nodes?.find((o) => !o.cancelledAt);
  if (!oldest || oldest.id !== order.id) return null;
  c.actions.referred_by = ref;
  const found = await admin(
    `query($q: String!) { customers(first: 2, query: $q) { nodes { id defaultAddress { address1 zip } } } }`,
    { q: `tag:"clubref${ref}"` }
  );
  const nodes = found.customers.nodes;
  if (nodes.length !== 1) { tags.push('club-ref-conflit'); return null; }
  if (nodes[0].id === c.id) return null;
  // Même adresse de livraison que la marraine : vérification manuelle, pas de crédit.
  if (sameAddress(nodes[0].defaultAddress, order.shippingAddress)) { tags.push('club-ref-suspect'); return null; }
  return nodes[0].id;
}

/** Côté marraine, idempotent : une commande de filleule ne crédite (ou ne reprend) qu'une fois. */
async function settleSponsor(sponsorId, order, reverse, firstName) {
  return withRetry(async () => {
    const s = await loadCustomer(sponsorId);
    const key = order.id.split('/').pop();
    s.actions.refs = s.actions.refs || {};
    const state = s.actions.refs[key];
    const points = CLUB.referralPoints;
    if (!reverse && !state) {
      s.points += points;
      s.total += points;
      s.history.unshift({ d: today(), p: points, l: `Parrainage — première commande de ${firstName || 'votre filleule'}` });
      s.actions.refs[key] = 'c';
      await saveCustomer(s);
      return 'credited';
    }
    if (reverse && state === 'c') {
      s.points -= points;
      s.total = Math.max(0, s.total - points);
      s.history.unshift({ d: today(), p: -points, l: `Parrainage repris — commande de ${firstName || 'votre filleule'} remboursée` });
      s.actions.refs[key] = 'v';
      await saveCustomer(s);
      return 'reversed';
    }
    return state === 'v' ? 'reversed' : state === 'c' ? 'credited' : 'none';
  });
}

async function syncOnce(orderId) {
  const { order } = await admin(ORDER_QUERY, { id: orderId });
  if (!order?.customer) return { skipped: 'sans cliente' };

  const c = await loadCustomer(order.customer.id);
  const name = order.name;
  const entry = c.ledger[name];
  let touched = false;

  // Pièce offerte utilisée sur cette commande : le code disparaît dès le paiement.
  const used = (order.discountCodes || []).map((x) => String(x).toUpperCase());
  if (!order.cancelledAt) {
    for (const g of c.actions.gifts) {
      if (g.code && !g.used && used.includes(g.code.toUpperCase())) { g.used = name; touched = true; }
    }
  }

  const paid = PAID.includes(order.displayFinancialStatus);
  const eligible = !order.cancelledAt && paid && order.displayFulfillmentStatus === 'FULFILLED';
  if (!entry && !eligible) {
    if (touched) { refreshRewardCode(c); countStamps(c); await saveCustomer(c); }
    const why = order.cancelledAt ? 'annulée' : !paid ? 'non payée' : 'pas encore expédiée en entier';
    return { skipped: why };
  }

  const base = orderBase(order);
  let targetP = order.cancelledAt ? 0 : Math.floor(base) * CLUB.pointsPerEuro;
  let targetS = !order.cancelledAt && base >= CLUB.stamps.minSubtotal ? 1 : 0;
  const e = entry ? { ...entry } : { p: 0, s: 0, d: today() };
  // Déjà créditée mais plus « expédiée en entier » (article ajouté) : on ne
  // crédite pas d'avance, on ne fait que reprendre.
  if (entry && !eligible && !order.cancelledAt) { targetP = Math.min(targetP, e.p); targetS = Math.min(targetS, e.s); }

  const { extra, tags } = await ensureJoined(c);
  const dP = targetP - e.p;
  const dS = targetS - e.s;
  e.p = targetP;
  e.s = targetS;
  c.ledger[name] = e;

  if (dP) {
    c.points += dP;
    c.total = Math.max(0, c.total + dP);
  }
  const giftNote = await reconcileGifts(c, name);
  if (!entry && targetS) {
    const sponsor = await findSponsor(c, order, tags);
    if (sponsor) e.r = sponsor;
  }
  if (e.r && !e.rv && !targetS) e.rv = 1;

  if (!entry || dP || dS || giftNote || touched) {
    const onCard = ((c.stamps - 1) % CLUB.stamps.goal) + 1;
    const stampNote = dS > 0 ? ` · tampon ${onCard}/${CLUB.stamps.goal}` : dS < 0 ? ' · tampon retiré' : '';
    const label = !entry ? `Commande ${name}`
      : order.cancelledAt ? `Commande ${name} annulée`
      : dP > 0 ? `Commande ${name} — ajustement` : `Remboursement ${name}`;
    if (!entry || dP || dS || giftNote) c.history.unshift({ d: today(), p: dP, l: `${label}${stampNote}${giftNote}`, o: name });
    await saveCustomer(c, { extra });
  }
  await safeTags(c.id, tags);

  let referral = null;
  if (e.r) referral = { sponsor: e.r, state: await settleSponsor(e.r, order, Boolean(e.rv), c.firstName) };
  return { order: name, credited: dP, points: e.p, stamp: Boolean(e.s), stamps: c.stamps, giftCode: c.rewardCode || null, referral };
}

export function syncOrder(orderId) {
  return withRetry(() => syncOnce(orderId));
}
