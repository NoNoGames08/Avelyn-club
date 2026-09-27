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
 *   points_total  entier  cumul gagné (fixe le palier, jamais diminué)
 *   tier          texte   identifiant du palier
 *   actions       json    { join: date, newsletter: date, … }
 *   history       json    [{ d, p, l, o?, c? }] — plus récent d'abord
 *   birthday      date    AAAA-MM-JJ
 *   ref           texte   code de parrainage
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
  return {
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
    rewardCode: c.rewardCode?.value && c.rewardCode.value !== '-' ? c.rewardCode.value : ''
  };
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
  await syncTierTags(c, current.id);
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

/** Crédite (ou débite) et trace le mouvement. Ne sauvegarde pas. */
export function credit(c, points, label, extra = {}) {
  c.points += points;
  if (points > 0) c.total += points;
  c.history.unshift({ d: new Date().toISOString().slice(0, 10), p: points, l: label, ...extra });
}

/** Rejoindre le club : +points une fois, et un code de parrainage. */
export function ensureJoined(c) {
  const extra = [];
  const tags = [];
  if (!c.ref) {
    c.ref = 'AV' + c.id.split('/').pop().slice(-6).padStart(6, '0');
    extra.push({ ownerId: c.id, namespace: 'loyalty', key: 'ref', type: 'single_line_text_field', value: c.ref });
    tags.push(`clubref${c.ref}`);
  }
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
    codes: c.history.filter((h) => h.c).slice(0, 10).map((h) => ({ code: h.c, label: h.l.replace(/^Échange : /, ''), date: h.d })),
    stamps: c.stamps,
    stampCode: c.rewardCode
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

/** Code « pièce offerte » de la carte à tampons : plafonné, une seule pièce, réservé à la cliente. */
export async function createStampGift(customerId, code) {
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
