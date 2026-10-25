import crypto from 'node:crypto';
import { HttpError, json } from './http.js';
import { CLUB, tierFor } from './club-config.js';

/*
 * Avelyn Club — accès Shopify et règles communes aux routes /api/*.
 *
 * Application Shopify : « avelyn-fidelite » (Dev Dashboard) — ses identifiants
 * sont dans CLUB_CLIENT_ID /
 * CLUB_CLIENT_SECRET. Le secret sert aussi à vérifier les jetons de session
 * envoyés par l'extension de l'espace client.
 *
 * Données : métachamps client (espace de noms « loyalty »)
 *   points        entier  solde échangeable
 *   points_total  entier  cumul gagné (fixe le palier ; un échange ne le baisse jamais, un remboursement si)
 *   tier          texte   identifiant du palier
 *   actions       json    { join: date, newsletter: date, … }
 *   history       json    [{ d, p, l, o? }] — plus récent d'abord, AFFICHAGE seulement
 *   orders        json    registre des commandes { "#1042": { p, s, d, r?, rv? } } — ce
 *                         qui a été crédité pour chacune (points, tampon, marraine) ;
 *                         source de vérité des tampons et de l'idempotence
 *   stamps        entier  tampons (recalculé depuis le registre)
 *   reward_code   texte   code « pièce offerte » en cours, « - » sinon
 *   tickets       entier  tickets du tirage
 *   birthday      date    AAAA-MM-JJ
 *   ref           texte   code de parrainage (AV + 6 caractères, unique)
 * Tags : club-<palier> (segments Klaviyo, accès anticipé), clubref<code>
 * (retrouver la marraine), bday<MMJJ> (tâche d'anniversaire).
 */

const VERSION = '2026-07';

function shopDomain() {
  // Boutique Avelyn Monaco par défaut : une variable de moins à régler dans Vercel.
  return (process.env.CLUB_SHOP_DOMAIN || 'e2ngf7-wj.myshopify.com').replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

let cached = null;

async function token() {
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;
  const id = process.env.CLUB_CLIENT_ID;
  const secret = process.env.CLUB_CLIENT_SECRET;
  if (!id || !secret) throw new HttpError(500, 'Club non configuré (CLUB_CLIENT_ID / CLUB_CLIENT_SECRET).');
  const response = await fetch(`https://${shopDomain()}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret })
  });
  const text = await response.text();
  if (!response.ok) throw new HttpError(500, 'Shopify refuse les identifiants du club.', text.slice(0, 300));
  const payload = JSON.parse(text);
  cached = { token: payload.access_token, expiresAt: Date.now() + (Number(payload.expires_in) || 86399) * 1000 };
  return cached.token;
}

export async function admin(query, variables = {}) {
  const response = await fetch(`https://${shopDomain()}/admin/api/${VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await token() },
    body: JSON.stringify({ query, variables })
  });
  const text = await response.text();
  if (response.status === 401 || response.status === 403) {
    cached = null;
    throw new HttpError(500, "Shopify refuse l'accès au club (portées de l'application ?).", text.slice(0, 300));
  }
  if (!response.ok) throw new HttpError(502, `Shopify a répondu ${response.status}.`, text.slice(0, 300));
  const payload = JSON.parse(text);
  if (payload.errors?.length) throw new HttpError(502, 'Shopify a rejeté la requête.', payload.errors.map((e) => e.message).join(' / '));
  return payload.data;
}

function userErrors(result, label) {
  const errors = result?.userErrors ?? [];
  if (errors.length) throw new HttpError(422, `${label} : ${errors.map((e) => e.message).join(' / ')}`);
  return result;
}

/* ---------- Requêtes HTTP ---------- */

export function cors(res) {
  // L'extension tourne dans un worker servi par extensions.shopifycdn.com.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

export function preflight(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

/**
 * Jeton de session de l'extension (JWT HS256 signé avec le secret de
 * l'application). `sub` porte l'identifiant de la cliente connectée.
 */
export function customerFromToken(req) {
  if (!req.headers.authorization && /[?&]signature=/.test(req.url || '')) return customerFromProxy(req);
  const header = req.headers.authorization || '';
  const jwt = header.replace(/^Bearer\s+/i, '');
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Session absente.');
  const [head, body, sig] = parts;
  const expected = crypto.createHmac('sha256', process.env.CLUB_CLIENT_SECRET || '').update(`${head}.${body}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Session invalide.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now - 10) throw new HttpError(401, 'Session expirée.');
  if (payload.aud && payload.aud !== process.env.CLUB_CLIENT_ID) throw new HttpError(401, 'Session destinée à une autre application.');
  if (!payload.sub || !String(payload.sub).startsWith('gid://shopify/Customer/')) throw new HttpError(401, 'Cliente non connectée.');
  return payload.sub;
}

/**
 * Page Avelyn Club du thème : elle appelle /apps/club/<route>, que Shopify
 * relaie ici (proxy d'application, vercel.json → /proxy/*) en signant la
 * requête et en y ajoutant la cliente connectée (logged_in_customer_id).
 */
function customerFromProxy(req) {
  const params = new URL(req.url, 'https://proxy.local').searchParams;
  const keys = [...new Set(params.keys())].filter((k) => k !== 'signature').sort();
  const message = keys.map((k) => `${k}=${params.getAll(k).join(',')}`).join('');
  const expected = crypto.createHmac('sha256', process.env.CLUB_CLIENT_SECRET || '').update(message).digest('hex');
  const a = Buffer.from(params.get('signature') || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Signature invalide.');
  if (params.get('shop') !== shopDomain()) throw new HttpError(401, 'Boutique inconnue.');
  if (Math.abs(Date.now() / 1000 - Number(params.get('timestamp'))) > 600) throw new HttpError(401, 'Requête expirée.');
  // Une page tierce ne peut pas poster du JSON vers la boutique sans
  // l'accord du navigateur : seule la page du club passe.
  if (req.method === 'POST' && !String(req.headers['content-type'] || '').includes('application/json')) throw new HttpError(415, 'Format refusé.');
  const id = params.get('logged_in_customer_id');
  if (!/^\d+$/.test(id || '')) throw new HttpError(401, 'Cliente non connectée.');
  return `gid://shopify/Customer/${id}`;
}

export { json };

/* ---------- Lecture / écriture de la cliente ---------- */

const CUSTOMER_QUERY = `
  query ClubCustomer($id: ID!) {
    customer(id: $id) {
      id
      firstName
      numberOfOrders
      tags
      emailMarketingConsent { marketingState }
      points: metafield(namespace: "loyalty", key: "points") { value compareDigest }
      pointsTotal: metafield(namespace: "loyalty", key: "points_total") { value }
      actions: metafield(namespace: "loyalty", key: "actions") { value }
      history: metafield(namespace: "loyalty", key: "history") { value }
      birthday: metafield(namespace: "loyalty", key: "birthday") { value }
      ref: metafield(namespace: "loyalty", key: "ref") { value }
      stamps: metafield(namespace: "loyalty", key: "stamps") { value }
      rewardCode: metafield(namespace: "loyalty", key: "reward_code") { value }
      tickets: metafield(namespace: "loyalty", key: "tickets") { value }
      ledger: metafield(namespace: "loyalty", key: "orders") { value compareDigest }
    }
  }
`;

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export async function loadCustomer(id) {
  const data = await admin(CUSTOMER_QUERY, { id });
  const c = data.customer;
  if (!c) throw new HttpError(404, 'Cliente introuvable.');
  const customer = {
    id: c.id,
    firstName: c.firstName || '',
    numberOfOrders: Number(c.numberOfOrders) || 0,
    tags: c.tags || [],
    subscribed: c.emailMarketingConsent?.marketingState === 'SUBSCRIBED',
    points: parseInt(c.points?.value ?? '0', 10) || 0,
    digest: c.points?.compareDigest ?? null,
    total: parseInt(c.pointsTotal?.value ?? '0', 10) || 0,
    actions: parseJson(c.actions?.value, {}),
    history: parseJson(c.history?.value, []),
    birthday: c.birthday?.value || '',
    ref: c.ref?.value || '',
    stamps: parseInt(c.stamps?.value ?? '0', 10) || 0,
    rewardCode: c.rewardCode?.value && c.rewardCode.value !== '-' ? c.rewardCode.value : '',
    tickets: parseInt(c.tickets?.value ?? '0', 10) || 0,
    ledger: parseJson(c.ledger?.value, {}),
    ledgerDigest: c.ledger?.compareDigest ?? null,
    hasLedger: Boolean(c.ledger)
  };
  migrate(customer);
  return customer;
}

/** Anciennes données (avant le registre) : reconstruites une fois depuis l'historique. */
export function migrate(c) {
  if (c.actions.v >= 2) return;
  c.migrated = true;
  if (!c.hasLedger) {
    const unstamped = c.actions.unstamped || [];
    const ledger = {};
    for (const h of [...c.history].reverse()) {
      if (h.o && !h.ro && /^Commande/.test(h.l || '')) {
        ledger[h.o] = { p: h.p || 0, s: h.s && !unstamped.includes(h.o) ? 1 : 0, d: h.d, ...(h.c ? { c: h.c } : {}) };
      }
    }
    for (const h of c.history) if (h.ro && ledger[h.ro] && h.p) ledger[h.ro].p += h.p;
    c.ledger = ledger;
  }
  const counted = Object.values(c.ledger).reduce((n, e) => n + (e.s ? 1 : 0), 0);
  c.actions.legacyStamps = Math.max(0, c.stamps - counted);
  const due = Math.floor(c.stamps / CLUB.stamps.goal) + (c.actions.giftDebt || 0);
  const gifts = Object.values(c.ledger).filter((e) => e.c && e.s).map((e) => ({ code: e.c, ...(e.c === c.rewardCode ? {} : { used: 'avant' }) }));
  if (c.rewardCode && !gifts.some((g) => g.code === c.rewardCode)) gifts.push({ code: c.rewardCode });
  while (gifts.length < due) gifts.unshift({ code: '', used: 'avant' });
  c.actions.gifts = gifts;
  c.actions.codes = c.actions.codes || c.history.filter((h) => h.c && /^CLUB-/.test(h.c)).map((h) => ({ code: h.c, label: (h.l || '').replace(/^Échange : /, ''), date: h.d }));
  delete c.actions.giftDebt;
  delete c.actions.unstamped;
  c.actions.v = 2;
}

/** Relance une opération sur conflit d'enregistrement (409), depuis une lecture fraîche. */
export async function withRetry(fn, tries = 4) {
  for (let i = 1; ; i += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 409 || i >= tries) throw error;
      await new Promise((r) => setTimeout(r, 150 * i));
    }
  }
}

const METAFIELDS_SET = `
  mutation ClubSave($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { key }
      userErrors { field message code }
    }
  }
`;

/**
 * Enregistre la cliente. Le solde est écrit avec `compareDigest` : si une
 * autre opération l'a modifié entre-temps (double clic, commande qui tombe
 * au même moment), Shopify refuse et on recommence depuis une lecture fraîche.
 */
export async function saveCustomer(c, { extra = [] } = {}) {
  const { current } = tierFor(c.total);
  const owner = c.id;
  const metafields = [
    { ownerId: owner, namespace: 'loyalty', key: 'points', type: 'number_integer', value: String(c.points), compareDigest: c.digest },
    { ownerId: owner, namespace: 'loyalty', key: 'orders', type: 'json', value: JSON.stringify(c.ledger || {}), compareDigest: c.ledgerDigest },
    { ownerId: owner, namespace: 'loyalty', key: 'stamps', type: 'number_integer', value: String(c.stamps) },
    { ownerId: owner, namespace: 'loyalty', key: 'reward_code', type: 'single_line_text_field', value: c.rewardCode || '-' },
    { ownerId: owner, namespace: 'loyalty', key: 'tickets', type: 'number_integer', value: String(c.tickets || 0) },
    { ownerId: owner, namespace: 'loyalty', key: 'points_total', type: 'number_integer', value: String(c.total) },
    { ownerId: owner, namespace: 'loyalty', key: 'tier', type: 'single_line_text_field', value: current.id },
    { ownerId: owner, namespace: 'loyalty', key: 'actions', type: 'json', value: JSON.stringify(c.actions) },
    { ownerId: owner, namespace: 'loyalty', key: 'history', type: 'json', value: JSON.stringify(c.history.slice(0, CLUB.historySize)) },
    ...extra
  ];
  const data = await admin(METAFIELDS_SET, { metafields });
  const errors = data.metafieldsSet.userErrors || [];
  if (errors.some((e) => e.code === 'STALE_OBJECT' || /digest|stale/i.test(e.message))) {
    throw new HttpError(409, 'Le solde vient de changer, réessayer.');
  }
  userErrors(data.metafieldsSet, 'Enregistrement du club');
  // Les tags de palier suivent : leur échec ne doit jamais annuler ce qui vient
  // d'être enregistré (ils sont réparés au prochain passage).
  try { await syncTierTags(c, current.id); } catch (error) { console.error('tags palier', c.id, error.message); }
}

async function syncTierTags(c, tierId) {
  const wanted = `club-${tierId}`;
  const stale = c.tags.filter((t) => t.startsWith('club-') && t !== wanted && CLUB.tiers.some((x) => `club-${x.id}` === t));
  if (!c.tags.includes(wanted)) {
    userErrors((await admin(`mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`, { id: c.id, tags: [wanted] })).tagsAdd, 'Tag palier');
  }
  if (stale.length) {
    userErrors((await admin(`mutation($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { field message } } }`, { id: c.id, tags: stale })).tagsRemove, 'Tag palier');
  }
}

export async function addTags(id, tags) {
  userErrors((await admin(`mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`, { id, tags })).tagsAdd, 'Tags');
}

/** Tags posés après un enregistrement réussi : jamais bloquants, réparés par ensureJoined. */
export async function safeTags(id, tags) {
  if (!tags.length) return;
  for (let i = 0; i < 3; i += 1) {
    try { await addTags(id, tags); return; } catch (error) { console.error('tags', id, tags, error.message); }
  }
}

/** Crédite (ou débite) et trace le mouvement. Ne sauvegarde pas. */
export function credit(c, points, label, extra = {}) {
  c.points += points;
  if (points > 0) c.total += points;
  c.history.unshift({ d: new Date().toISOString().slice(0, 10), p: points, l: label, ...extra });
}

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const REF_PATTERN = /^AV[A-Z0-9]{6}$/;

/** Code de parrainage aléatoire, vérifié unique (tag clubref<code>). */
async function uniqueRef() {
  for (let i = 0; i < 6; i += 1) {
    let code = 'AV';
    for (const byte of crypto.randomBytes(6)) code += REF_ALPHABET[byte % REF_ALPHABET.length];
    const found = await admin(`query($q: String!) { customers(first: 1, query: $q) { nodes { id } } }`, { q: `tag:"clubref${code}"` });
    if (!found.customers.nodes.length) return code;
  }
  throw new HttpError(503, 'Code de parrainage indisponible, réessayer.');
}

export function birthdayTag(date) {
  return date ? `bday${date.slice(5, 7)}${date.slice(8, 10)}` : '';
}

/**
 * Rejoindre le club : +points une fois, et un code de parrainage. Répare
 * aussi les tags manquants (un tagsAdd raté ne doit jamais rendre un code de
 * parrainage introuvable, ni faire sauter un anniversaire ou une demande).
 * Ne sauvegarde pas : renvoie les métachamps et tags à poser après.
 */
export async function ensureJoined(c) {
  const extra = [];
  const tags = [];
  if (!c.ref) {
    c.ref = await uniqueRef();
    extra.push({ ownerId: c.id, namespace: 'loyalty', key: 'ref', type: 'single_line_text_field', value: c.ref });
  }
  const wanted = [`clubref${c.ref}`];
  if (c.birthday) wanted.push(birthdayTag(c.birthday));
  if ((c.tickets || 0) > 0) wanted.push('club-tirage');
  for (const r of c.actions.requests || []) wanted.push('club-demande', `club-demande-${r.id}`);
  for (const t of wanted) if (!c.tags.includes(t) && !tags.includes(t)) tags.push(t);
  let joined = false;
  if (!c.actions.join) {
    c.actions.join = new Date().toISOString().slice(0, 10);
    credit(c, CLUB.actions.join.points, 'Bienvenue au club');
    joined = true;
  }
  return { extra, tags, joined };
}

/** Ce que l'extension et la page affichent. */
export function publicState(c) {
  const { current, next } = tierFor(c.total);
  return {
    firstName: c.firstName,
    points: c.points,
    total: c.total,
    tier: current,
    nextTier: next,
    toNextTier: next ? next.min - c.total : 0,
    tiers: CLUB.tiers,
    rewards: CLUB.rewards.map((r) => ({ ...r, affordable: c.points >= r.points })),
    actions: Object.entries(CLUB.actions)
      .filter(([id]) => id !== 'join')
      .map(([id, a]) => ({ id, label: a.label, points: a.points, url: a.url || null, done: Boolean(c.actions[id]) })),
    birthday: c.birthday,
    birthdayGift: CLUB.birthdayGift,
    referral: { code: c.ref, url: c.ref ? `${CLUB.storeUrl}/?ref=${c.ref}` : '', points: CLUB.referralPoints },
    pointsPerEuro: CLUB.pointsPerEuro,
    history: c.history.slice(0, 15),
    codes: (c.actions.codes || []).slice(0, 10),
    stamps: c.stamps,
    stampCode: c.rewardCode,
    stampMin: CLUB.stamps.minSubtotal,
    tickets: c.tickets
  };
}

/* ---------- Codes de réduction ---------- */

export function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (const byte of crypto.randomBytes(6)) out += alphabet[byte % alphabet.length];
  return `CLUB-${out}`;
}

export async function createDiscount(customerId, reward, code) {
  const base = {
    title: `Avelyn Club — ${reward.label} (${code})`,
    code,
    startsAt: new Date().toISOString(),
    usageLimit: 1,
    appliesOncePerCustomer: true,
    context: { customers: { add: [customerId] } },
    combinesWith: { productDiscounts: true, orderDiscounts: false, shippingDiscounts: reward.kind !== 'shipping' }
  };
  if (reward.kind === 'shipping') {
    const data = await admin(
      `mutation($d: DiscountCodeFreeShippingInput!) { discountCodeFreeShippingCreate(freeShippingCodeDiscount: $d) { codeDiscountNode { id } userErrors { field message } } }`,
      { d: { ...base, destination: { all: true } } }
    );
    return userErrors(data.discountCodeFreeShippingCreate, 'Création de la réduction');
  }
  const data = await admin(
    `mutation($d: DiscountCodeBasicInput!) { discountCodeBasicCreate(basicCodeDiscount: $d) { codeDiscountNode { id } userErrors { field message } } }`,
    { d: { ...base, customerGets: { value: { discountAmount: { amount: reward.amount, appliesOnEachItem: false } }, items: { all: true } } } }
  );
  return userErrors(data.discountCodeBasicCreate, 'Création de la réduction');
}

/**
 * Code « pièce offerte » de la carte à tampons : plafonné, une seule pièce,
 * réservé à la cliente. Idempotent : si le code existe déjà (webhook relancé
 * par Shopify après un échec d'enregistrement), on ne le recrée pas.
 */
export async function createStampGift(customerId, code) {
  const existing = await admin(`query($code: String!) { codeDiscountNodeByCode(code: $code) { id } }`, { code });
  if (existing.codeDiscountNodeByCode?.id) return existing.codeDiscountNodeByCode;
  const { giftCollectionId, giftAmount, giftLabel } = CLUB.stamps;
  const data = await admin(
    `mutation($d: DiscountCodeBasicInput!) { discountCodeBasicCreate(basicCodeDiscount: $d) { codeDiscountNode { id } userErrors { field message } } }`,
    { d: {
      title: `${giftLabel} (${code})`,
      code,
      startsAt: new Date().toISOString(),
      usageLimit: 1,
      appliesOncePerCustomer: true,
      context: { customers: { add: [customerId] } },
      customerGets: { value: { discountAmount: { amount: giftAmount, appliesOnEachItem: false } }, items: { collections: { add: [giftCollectionId] } } },
      combinesWith: { productDiscounts: false, orderDiscounts: false, shippingDiscounts: true }
    } }
  );
  return userErrors(data.discountCodeBasicCreate, 'Code pièce offerte');
}

/**
 * Retire un code de réduction s'il n'a pas servi. Renvoie « used » s'il a
 * déjà été utilisé (on ne peut plus le reprendre), « deleted » sinon.
 */
export async function revokeCodeIfUnused(code) {
  const found = await admin(
    `query($code: String!) { codeDiscountNodeByCode(code: $code) { id codeDiscount { ... on DiscountCodeBasic { asyncUsageCount } ... on DiscountCodeFreeShipping { asyncUsageCount } } } }`,
    { code }
  );
  const node = found.codeDiscountNodeByCode;
  if (!node) return 'absent';
  if ((node.codeDiscount?.asyncUsageCount || 0) > 0) return 'used';
  userErrors((await admin(`mutation($id: ID!) { discountCodeDelete(id: $id) { deletedCodeDiscountId userErrors { field message } } }`, { id: node.id })).discountCodeDelete, 'Retrait du code');
  return 'deleted';
}

/**
 * Jeton de session d'une extension (espace client OU page de remerciement).
 * Contrairement à customerFromToken, la cliente peut être absente (achat
 * sans compte) : renvoie le contenu du jeton vérifié.
 */
export function verifySessionToken(req) {
  const jwt = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Session absente.');
  const [head, body, sig] = parts;
  const expected = crypto.createHmac('sha256', process.env.CLUB_CLIENT_SECRET || '').update(`${head}.${body}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Session invalide.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000) - 10) throw new HttpError(401, 'Session expirée.');
  if (payload.aud && payload.aud !== process.env.CLUB_CLIENT_ID) throw new HttpError(401, 'Session destinée à une autre application.');
  return payload;
}
