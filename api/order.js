import crypto from 'node:crypto';
import { HttpError, fail, str } from './_lib/http.js';
import { CLUB } from './_lib/club-config.js';
import { admin, loadCustomer, saveCustomer, ensureJoined, credit, addTags, createStampGift, revokeCodeIfUnused, json } from './_lib/club.js';

/**
 * POST /api/order — webhook Shopify « orders/fulfilled » de l'app
 * avelyn-fidelite (déclaré dans shopify.app.toml). Signature vérifiée avec
 * le secret de l'app (en-tête X-Shopify-Hmac-Sha256, corps brut).
 *
 * Tout se valide quand la commande est EXPÉDIÉE en entier (pas à la commande) :
 * - tampon (+ code « pièce offerte » au 3e, usage unique, réservé à la cliente)
 * - points d'achat : sous-total payé (après remises, hors livraison) × barème
 * - parrainage : attribut de panier _club_ref posé par le thème quand la
 *   visiteuse arrive par un lien ?ref= — crédité à la marraine si c'est la
 *   première commande de la filleule
 * La commande est relue chez Shopify (payée, expédiée, non annulée) et chaque commande
 * n'est créditée qu'une fois : les renvois du webhook sont sans effet.
 *
 * Même route pour « refunds/create » (en-tête X-Shopify-Topic) : un
 * remboursement retire les points correspondants ; une commande remboursée
 * en entier perd son tampon, et le code « pièce offerte » qu'elle avait
 * déclenché est supprimé s'il n'a pas servi. S'il a déjà servi, la cliente
 * « doit » une pièce : la prochaine carte complétée n'en redonne pas.
 * Sans ça : trois commandes, la pièce offerte, puis trois retours remboursés.
 */
export const config = { api: { bodyParser: false } };

async function rawBody(req) {
  // Lire le flux AVANT tout accès à req.body : sur Vercel, ce getter décode
  // le JSON à la volée et les octets exacts (ceux que Shopify a signés) sont perdus.
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  if (chunks.length) return Buffer.concat(chunks).toString('utf8');
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  throw new HttpError(500, 'Corps brut indisponible : impossible de vérifier la signature.');
}

function verifyWebhook(req, raw) {
  const given = req.headers['x-shopify-hmac-sha256'] || '';
  const expected = crypto.createHmac('sha256', process.env.CLUB_CLIENT_SECRET || '').update(raw, 'utf8').digest('base64');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (!given || a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Signature du webhook invalide.');
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'Méthode non autorisée.');
    const raw = await rawBody(req);
    verifyWebhook(req, raw);
    let payload;
    try { payload = JSON.parse(raw); } catch { throw new HttpError(400, 'Corps illisible.'); }
    const topic = String(req.headers['x-shopify-topic'] || 'orders/fulfilled');
    const orderId = topic === 'refunds/create'
      ? (payload.order_id ? `gid://shopify/Order/${payload.order_id}` : '')
      : str(payload.admin_graphql_api_id || (payload.id ? `gid://shopify/Order/${payload.id}` : ''), { max: 80 });
    if (!/^gid:\/\/shopify\/Order\/\d+$/.test(orderId)) throw new HttpError(400, 'orderId invalide.');
    if (topic === 'refunds/create') return json(res, 200, await handleRefund(orderId));

    const { order } = await admin(
      `query($id: ID!) { order(id: $id) {
        id name cancelledAt displayFinancialStatus displayFulfillmentStatus discountCodes
        currentSubtotalPriceSet { shopMoney { amount } }
        customAttributes { key value }
        customer { id }
      } }`,
      { id: orderId }
    );
    if (!order?.customer) return json(res, 200, { skipped: 'sans cliente' });
    if (order.cancelledAt) return json(res, 200, { skipped: 'annulée' });
    if (!['PAID', 'PARTIALLY_REFUNDED'].includes(order.displayFinancialStatus)) return json(res, 200, { skipped: 'non payée' });
    if (order.displayFulfillmentStatus !== 'FULFILLED') return json(res, 200, { skipped: 'pas encore expédiée en entier' });

    const c = await loadCustomer(order.customer.id);
    if (c.history.some((h) => h.o === order.name)) return json(res, 200, { skipped: 'déjà créditée' });

    const { extra, tags } = ensureJoined(c);
    const subtotal = Number(order.currentSubtotalPriceSet.shopMoney.amount) || 0;
    const euros = Math.floor(subtotal);
    const earned = euros * CLUB.pointsPerEuro;

    // Carte à tampons
    const { goal } = CLUB.stamps;
    let stampLabel = '';
    let giftCode = null;
    const usedGift = c.rewardCode && (order.discountCodes || []).some((d) => d.toUpperCase() === c.rewardCode.toUpperCase());
    if (usedGift) c.rewardCode = '';
    if (subtotal > 0) {
      c.stamps += 1;
      const onCard = ((c.stamps - 1) % goal) + 1;
      stampLabel = ` · tampon ${onCard}/${goal}`;
      if (onCard === goal) {
        if ((c.actions.giftDebt || 0) > 0) {
          // Pièce déjà reçue sur une carte dont une commande a été remboursée.
          c.actions.giftDebt -= 1;
          stampLabel += ' — pièce déjà offerte';
        } else {
          giftCode = `AV-GIFT-${order.name.replace(/\D/g, '')}`;
          await createStampGift(c.id, giftCode);
          c.rewardCode = giftCode;
          stampLabel += ' — pièce offerte';
        }
      }
    }
    extra.push(
      { ownerId: c.id, namespace: 'loyalty', key: 'stamps', type: 'number_integer', value: String(c.stamps) },
      { ownerId: c.id, namespace: 'loyalty', key: 'reward_code', type: 'single_line_text_field', value: c.rewardCode || '-' }
    );

    const mark = { o: order.name, ...(subtotal > 0 ? { s: 1 } : {}), ...(giftCode ? { c: giftCode } : {}) };
    if (earned > 0) credit(c, earned, `Commande ${order.name}${stampLabel}`, mark);
    else c.history.unshift({ d: new Date().toISOString().slice(0, 10), p: 0, l: `Commande ${order.name}${stampLabel}`, ...mark });

    // Parrainage — la filleule n'est créditée qu'une fois, sur sa première commande.
    const ref = (order.customAttributes || []).find((a) => a.key === '_club_ref')?.value?.trim().toUpperCase();
    let referral = null;
    if (ref && ref !== c.ref && c.numberOfOrders <= 1 && !c.actions.referred_by) {
      const found = await admin(`query($q: String!) { customers(first: 1, query: $q) { nodes { id } } }`, { q: `tag:clubref${ref}` });
      const sponsorId = found.customers.nodes[0]?.id;
      if (sponsorId && sponsorId !== c.id) {
        c.actions.referred_by = ref;
        const sponsor = await loadCustomer(sponsorId);
        credit(sponsor, CLUB.referralPoints, `Parrainage — première commande de ${c.firstName || 'votre filleule'}`);
        await saveCustomer(sponsor);
        referral = sponsorId;
      }
    }

    await saveCustomer(c, { extra });
    if (tags.length) await addTags(c.id, tags);
    return json(res, 200, { credited: earned, stamps: c.stamps, giftCode, referral });
  } catch (error) {
    return fail(res, error);
  }
}

/** Remboursement (partiel ou total) d'une commande déjà créditée. */
async function handleRefund(orderId) {
  const { order } = await admin(
    `query($id: ID!) { order(id: $id) { id name currentSubtotalPriceSet { shopMoney { amount } } customer { id } } }`,
    { id: orderId }
  );
  if (!order?.customer) return { skipped: 'sans cliente' };
  const c = await loadCustomer(order.customer.id);
  const credited = c.history.find((h) => h.o === order.name);
  // Pas encore expédiée : rien à reprendre, le crédit se fera sur le montant restant.
  if (!credited) return { skipped: 'pas encore créditée' };

  const today = new Date().toISOString().slice(0, 10);
  const subtotal = Number(order.currentSubtotalPriceSet.shopMoney.amount) || 0;
  const target = Math.floor(Math.max(subtotal, 0)) * CLUB.pointsPerEuro;
  const already = credited.p + c.history.filter((h) => h.ro === order.name).reduce((sum, h) => sum + h.p, 0);
  const delta = target - already;
  if (delta < 0) {
    c.points += delta; // peut passer sous zéro si les points ont déjà été échangés : c'est voulu
    c.total = Math.max(0, c.total + delta);
    c.history.unshift({ d: today, p: delta, l: `Remboursement ${order.name}`, ro: order.name });
  }

  const extra = [];
  c.actions.unstamped = c.actions.unstamped || [];
  let revoked = null;
  if (subtotal <= 0 && credited.s && !c.actions.unstamped.includes(order.name)) {
    c.stamps = Math.max(0, c.stamps - 1);
    c.actions.unstamped.push(order.name);
    if (credited.c) {
      revoked = await revokeCodeIfUnused(credited.c);
      if (revoked === 'used') c.actions.giftDebt = (c.actions.giftDebt || 0) + 1;
      else if (c.rewardCode === credited.c) c.rewardCode = '';
    }
    c.history.unshift({ d: today, p: 0, l: `Tampon retiré — ${order.name} remboursée`, ro: order.name });
    extra.push(
      { ownerId: c.id, namespace: 'loyalty', key: 'stamps', type: 'number_integer', value: String(c.stamps) },
      { ownerId: c.id, namespace: 'loyalty', key: 'reward_code', type: 'single_line_text_field', value: c.rewardCode || '-' }
    );
  }
  if (delta >= 0 && !extra.length) return { skipped: 'rien à reprendre' };
  await saveCustomer(c, { extra });
  return { removedPoints: Math.min(delta, 0), stamps: c.stamps, revoked };
}
