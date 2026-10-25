// Tests du serveur Avelyn Club contre un faux Shopify (aucun appel réel).
// Lancer : node tests/club.test.mjs
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'api');
process.env.CLUB_SHOP_DOMAIN = 'test.myshopify.com';
process.env.CLUB_CLIENT_ID = 'cid';
process.env.CLUB_CLIENT_SECRET = 'secret';

// ---------- faux Shopify ----------
const C = (n) => `gid://shopify/Customer/${n}`;
const O = (n) => `gid://shopify/Order/${n}`;
const L = C(1), I = C(2), K = C(3), M = C(4), Q = C(5), P = C(6), S1 = C(7), S2 = C(8), N = C(9), Z = C(10), V = C(11);
let clock = Date.parse('2026-10-01T10:00:00Z');
const db = { customers: {}, orders: {}, discounts: [], used: new Set(), n: 0, failSave: new Set(), failDiscount: false, broken: new Set() };
const cust = (id, firstName, extra = {}) => { db.customers[id] = { firstName, tags: [], sub: 'NOT_SUBSCRIBED', mf: {}, defaultAddress: null, ...extra }; };
[[L, 'Léa'], [I, 'Inès'], [K, 'Kim'], [M, 'Mia'], [Q, 'Quitterie'], [P, 'Paule'], [S1, 'Sam'], [S2, 'Sasha'], [N, 'Nina'], [Z, 'Zoé'], [V, 'Vera']].forEach(([id, n]) => cust(id, n));
// Commande : par défaut payée et expédiée en entier, 72,50 €.
const mkOrder = (num, customer, amount = '72.50', extra = {}) => {
  clock += 60000;
  db.orders[O(num)] = {
    name: `#${num}`, customer, createdAt: new Date(clock).toISOString(), cancelledAt: null,
    displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED', discountCodes: [], customAttributes: [],
    currentSubtotalPriceSet: { shopMoney: { amount } }, lineItems: { nodes: [] }, shippingAddress: { address1: '1 rue de la Plage', zip: '06000' },
    ...extra
  };
  return O(num);
};
const mf = (c, k) => (c.mf[k] ? { value: c.mf[k].value, compareDigest: c.mf[k].digest } : null);
const resp = (data) => new Response(JSON.stringify({ data }));
const ordersOf = (customer) => Object.entries(db.orders).filter(([, o]) => o.customer === customer).sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt));
const tagOf = (q) => q.replace(/^tag:/, '').replace(/"/g, '');

globalThis.fetch = async (url, opts) => {
  if (url.includes('access_token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 86399 }));
  const { query: q, variables: v } = JSON.parse(opts.body);
  if (q.includes('ClubCustomer')) {
    const c = db.customers[v.id];
    if (!c || db.broken.has(v.id)) return resp({ customer: null });
    return resp({ customer: { id: v.id, firstName: c.firstName, numberOfOrders: ordersOf(v.id).length, tags: c.tags, emailMarketingConsent: { marketingState: c.sub },
      points: mf(c, 'points'), pointsTotal: mf(c, 'points_total'), actions: mf(c, 'actions'), history: mf(c, 'history'), birthday: mf(c, 'birthday'),
      ref: mf(c, 'ref'), stamps: mf(c, 'stamps'), rewardCode: mf(c, 'reward_code'), tickets: mf(c, 'tickets'), ledger: mf(c, 'orders') } });
  }
  if (q.includes('metafieldsSet')) {
    const owner = v.metafields[0].ownerId;
    if (db.failSave.has(owner)) { db.failSave.delete(owner); return resp({ metafieldsSet: { metafields: [], userErrors: [{ field: ['x'], message: 'stale', code: 'STALE_OBJECT' }] } }); }
    const errs = [];
    for (const m of v.metafields) {
      const cur = db.customers[m.ownerId].mf[m.key];
      if ('compareDigest' in m && (m.compareDigest ?? null) !== (cur?.digest ?? null)) errs.push({ field: ['metafields'], message: 'stale', code: 'STALE_OBJECT' });
    }
    if (!errs.length) for (const m of v.metafields) db.customers[m.ownerId].mf[m.key] = { value: m.value, digest: 'd' + ++db.n };
    return resp({ metafieldsSet: { metafields: [], userErrors: errs } });
  }
  if (q.includes('tagsAdd')) { const c = db.customers[v.id]; for (const t of v.tags) if (!c.tags.includes(t)) c.tags.push(t); return resp({ tagsAdd: { userErrors: [] } }); }
  if (q.includes('tagsRemove')) { const c = db.customers[v.id]; c.tags = c.tags.filter((t) => !v.tags.includes(t)); return resp({ tagsRemove: { userErrors: [] } }); }
  if (q.includes('customerEmailMarketingConsentUpdate')) { db.customers[v.input.customerId].sub = 'SUBSCRIBED'; return resp({ customerEmailMarketingConsentUpdate: { userErrors: [] } }); }
  if (q.includes('codeDiscountNodeByCode')) {
    const d = db.discounts.find((x) => x.code.toUpperCase() === v.code.toUpperCase() && !x.deleted);
    return resp({ codeDiscountNodeByCode: d ? { id: 'disc-' + d.code, codeDiscount: { asyncUsageCount: db.used.has(d.code) ? 1 : 0 } } : null });
  }
  if (q.includes('discountCodeDelete')) { db.discounts.find((x) => 'disc-' + x.code === v.id && !x.deleted).deleted = true; return resp({ discountCodeDelete: { deletedCodeDiscountId: v.id, userErrors: [] } }); }
  if (q.includes('discountCodeBasicCreate') || q.includes('discountCodeFreeShippingCreate')) {
    const key = q.includes('Basic') ? 'discountCodeBasicCreate' : 'discountCodeFreeShippingCreate';
    if (db.failDiscount) { db.failDiscount = false; return resp({ [key]: { codeDiscountNode: null, userErrors: [{ field: ['x'], message: 'refusé' }] } }); }
    if (db.discounts.some((x) => x.code === v.d.code && !x.deleted)) return resp({ [key]: { codeDiscountNode: null, userErrors: [{ field: ['code'], message: 'Code must be unique' }] } });
    db.discounts.push(v.d); return resp({ [key]: { codeDiscountNode: { id: 'x' }, userErrors: [] } });
  }
  if (q.includes('customer(id') && q.includes('orders(')) {
    return resp({ customer: { orders: { nodes: ordersOf(v.id).map(([id, o]) => ({ id, cancelledAt: o.cancelledAt })) } } });
  }
  if (q.includes('order(id')) {
    const o = db.orders[v.id];
    if (!o) return resp({ order: null });
    const c = db.customers[o.customer];
    const nodes = ordersOf(o.customer).reverse().map(([, x]) => x);
    return resp({ order: { id: v.id, ...o, customer: o.customer ? { id: o.customer, stamps: mf(c, 'stamps'), ledger: mf(c, 'orders'), actions: mf(c, 'actions'), orders: { nodes } } : null } });
  }
  if (q.includes('orders(first')) {
    return resp({ orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: Object.entries(db.orders).map(([id, o]) => ({ id, name: o.name })) } });
  }
  if (q.includes('customers(first')) {
    const tag = tagOf(v.q);
    const nodes = Object.entries(db.customers).filter(([, c]) => c.tags.includes(tag)).map(([id, c]) => ({ id, defaultAddress: c.defaultAddress }));
    return resp({ customers: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } });
  }
  throw new Error('requête non simulée : ' + q.slice(0, 80));
};

// ---------- appels ----------
const jwt = (sub, extra = {}) => {
  const h = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');
  const b = Buffer.from(JSON.stringify({ ...(sub ? { sub } : {}), aud: 'cid', exp: Math.floor(Date.now() / 1000) + 60, ...extra })).toString('base64url');
  return `${h}.${b}.${crypto.createHmac('sha256', 'secret').update(h + '.' + b).digest('base64url')}`;
};
const mkRes = () => { const r = {}; r.status = (c) => { r.code = c; return r; }; r.setHeader = () => {}; r.end = (b) => { r.body = b ? JSON.parse(b) : null; }; return r; };
async function call(route, { method = 'GET', sub, body, url, token, topic, badsig } = {}) {
  const h = (await import(path.join(API, route + '.js'))).default;
  const res = mkRes();
  if (route === 'order') {
    const raw = topic === 'refunds/create' ? JSON.stringify({ order_id: Number(body.orderId.split('/').pop()) }) : JSON.stringify({ admin_graphql_api_id: body.orderId });
    const sig = badsig ? 'xx' : crypto.createHmac('sha256', 'secret').update(raw).digest('base64');
    const req = (async function* () { yield Buffer.from(raw); })();
    req.method = method; req.headers = { 'x-shopify-hmac-sha256': sig, ...(topic ? { 'x-shopify-topic': topic } : {}) };
    Object.defineProperty(req, 'body', { get() { throw new Error('req.body lu : corps brut perdu'); } });
    await h(req, res); return res;
  }
  const auth = token || (sub ? jwt(sub) : null);
  await h({ method, url: url || '/', headers: auth ? { authorization: 'Bearer ' + auth } : (method === 'POST' ? { 'content-type': 'application/json' } : {}), body }, res);
  return res;
}
const hook = (id, topic = 'orders/fulfilled') => call('order', { method: 'POST', body: { orderId: id }, topic });
const refund = (id) => hook(id, 'refunds/create');
const pts = (id) => Number(db.customers[id].mf.points?.value || 0);
const stamps = (id) => Number(db.customers[id].mf.stamps?.value || 0);
const code = (id) => db.customers[id].mf.reward_code?.value;
const ref = (id) => db.customers[id].mf.ref?.value;
const activeGifts = () => db.discounts.filter((d) => d.code.startsWith('AV-GIFT') && !d.deleted).map((d) => d.code);
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else fail++; console.log((cond ? '✓ ' : '✗ ') + msg); };
const section = (t) => console.log(`\n— ${t}`);

// ---------- inscription et actions ----------
section('inscription et actions');
let r = await call('me', { sub: I });
ok(r.code === 200 && r.body.points === 200 && r.body.welcome, 'inscription : +200');
ok(/^AV[A-Z2-9]{6}$/.test(r.body.referral.code) && db.customers[I].tags.includes(`clubref${ref(I)}`) && db.customers[I].tags.includes('club-plage'), 'code de parrainage aléatoire, tags');
r = await call('me', { sub: I }); ok(r.body.points === 200 && !r.body.welcome, 'pas de double bienvenue');
r = await call('me', {}); ok(r.code === 401, 'sans session : 401');
r = await call('me', { token: 'a.b.c' }); ok(r.code === 401, 'jeton falsifié : 401');
r = await call('action', { method: 'POST', sub: I, body: { type: 'newsletter' } }); ok(r.body.points === 500 && r.body.gained === 300 && db.customers[I].sub === 'SUBSCRIBED', 'newsletter : +300 et inscrite');
r = await call('action', { method: 'POST', sub: I, body: { type: 'newsletter' } }); ok(r.body.already && r.body.points === 500, 'newsletter une seule fois');
r = await call('action', { method: 'POST', sub: I, body: { type: 'birthday', date: '2003-01-15' } }); ok(r.body.points === 600 && db.customers[I].tags.includes('bday0115'), 'anniversaire : +100, tag');
r = await call('action', { method: 'POST', sub: I, body: { type: 'birthday', date: '2003-01-16' } }); ok(r.body.points === 600 && r.body.birthday === '2003-01-16' && db.customers[I].tags.includes('bday0116'), 'anniversaire corrigé sous 7 jours, sans nouveaux points');
r = await call('action', { method: 'POST', sub: L, body: { type: 'tiktok' } }); ok(r.body.gained === 300 && r.body.points === 300, 'première action sans visite : bienvenue + action, gain exact');
db.customers[I].tags = db.customers[I].tags.filter((t) => !t.startsWith('clubref'));
await call('me', { sub: I }); ok(db.customers[I].tags.includes(`clubref${ref(I)}`), 'tag de parrainage manquant : réparé');
r = await call('redeem', { method: 'POST', sub: I, body: { reward: 'eur5' } }); ok(r.code === 400, 'échange refusé sous le seuil');

// ---------- commandes ----------
section('commandes');
const o10 = mkOrder(10, I);
r = await hook(o10); ok(r.body.credited === 720 && r.body.stamps === 1, 'commande expédiée 72,50 € : +720, tampon 1');
r = await hook(o10); ok(r.body.credited === 0 && pts(I) === 1320, 'webhook rejoué : sans effet');
r = await hook(o10, 'orders/updated'); ok(r.body.credited === 0 && stamps(I) === 1, 'autre sujet sur la même commande : sans effet');
const o12 = mkOrder(12, I, '72.50', { displayFinancialStatus: 'PENDING', displayFulfillmentStatus: 'UNFULFILLED' });
r = await hook(o12, 'orders/updated'); ok(r.body.skipped === 'non payée', 'commande non payée : rien');
db.orders[o12].displayFinancialStatus = 'PAID';
r = await hook(o12, 'orders/paid'); ok(r.body.skipped === 'pas encore expédiée en entier', 'payée, pas expédiée : rien');
db.orders[o12].displayFulfillmentStatus = 'FULFILLED';
r = await hook(o12, 'orders/updated'); ok(r.body.credited === 720 && stamps(I) === 2, 'expédiée après paiement : créditée par n’importe quel sujet');
const o13 = mkOrder(13, I, '200');
await hook(o13);
r = await call('me', { sub: I }); ok(r.body.tier.id === 'terrasse' && db.customers[I].tags.includes('club-terrasse') && !db.customers[I].tags.includes('club-plage'), 'palier Terrasse, tags à jour');
ok(stamps(I) === 3 && code(I) === 'AV-GIFT-13', '3e tampon : code pièce offerte');
const g = db.discounts.find((d) => d.code === 'AV-GIFT-13');
ok(g.customerGets.value.discountAmount.amount === '75.00' && g.customerGets.items.collections.add[0].endsWith('710939246934') && g.context.customers.add[0] === I, 'code : 75 € max sur Cadeaux fidélité, réservé à la cliente');
const o15 = mkOrder(15, I, '72.50', { discountCodes: ['av-gift-13'], displayFulfillmentStatus: 'UNFULFILLED' });
r = await hook(o15, 'orders/paid'); ok(code(I) === '-' && stamps(I) === 3, 'pièce offerte utilisée : le code disparaît dès le paiement');
r = await call('thankyou', { token: jwt(I), url: `/api/thankyou?order=${o15}` }); ok(r.body.counts && r.body.slot === 1 && !r.body.completes, 'remerciement : tampon 1 de la nouvelle carte');
db.orders[o15].displayFulfillmentStatus = 'FULFILLED';
await hook(o15); ok(stamps(I) === 4 && code(I) === '-', 'nouvelle carte : 4e tampon, aucun nouveau code');
const o16 = mkOrder(16, I, '0.00');
await hook(o16); ok(stamps(I) === 4, 'commande à 0 € : pas de tampon');
const o17 = mkOrder(17, I, '35.00');
r = await hook(o17); ok(r.body.credited === 350 && stamps(I) === 4, 'commande de 35 € : points, pas de tampon');
const o18 = mkOrder(18, I, '50.00', { lineItems: { nodes: [{ isGiftCard: true, currentQuantity: 1, discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '40.00' } } }] } });
r = await hook(o18); ok(r.body.credited === 100 && stamps(I) === 4, 'carte cadeau exclue : 10 € comptés, pas de tampon');
r = await call('order', { method: 'POST', body: { orderId: o10 }, badsig: true }); ok(r.code === 401, 'webhook mal signé : 401');
const before = pts(I);
const hist = JSON.parse(db.customers[I].mf.history.value);
for (let i = 0; i < 100; i += 1) hist.unshift({ d: '2026-10-01', p: 0, l: 'bruit' });
db.customers[I].mf.history.value = JSON.stringify(hist);
r = await hook(o10); ok(r.body.credited === 0 && pts(I) === before, 'historique saturé : une vieille commande n’est jamais recréditée');

// ---------- remboursements, annulations, pièce offerte ----------
section('remboursements et pièce offerte');
const k = [40, 41, 42].map((n) => mkOrder(n, K, '50.00'));
for (const id of k) await hook(id);
ok(stamps(K) === 3 && code(K) === 'AV-GIFT-42', 'K : 3 tampons, pièce offerte');
db.used.add('AV-GIFT-42');
Object.assign(db.orders[k[0]], { currentSubtotalPriceSet: { shopMoney: { amount: '0.00' } }, displayFinancialStatus: 'REFUNDED' });
r = await refund(k[0]); ok(stamps(K) === 2 && r.body.credited === -500 && activeGifts().includes('AV-GIFT-42'), 'pièce déjà utilisée puis 1re commande remboursée : tampon retiré, pièce gardée');
const k43 = mkOrder(43, K, '50.00');
r = await hook(k43); ok(stamps(K) === 3 && code(K) === '-' && !activeGifts().includes('AV-GIFT-43'), 'carte recomplétée : pas de 2e pièce');
const q = [50, 51, 52].map((n) => mkOrder(n, Q, '60.00'));
for (const id of q) await hook(id);
Object.assign(db.orders[q[0]], { currentSubtotalPriceSet: { shopMoney: { amount: '0.00' } }, displayFinancialStatus: 'REFUNDED' });
r = await refund(q[0]); ok(stamps(Q) === 2 && code(Q) === '-' && !activeGifts().includes('AV-GIFT-52'), 'pièce non utilisée puis 1re commande remboursée : pièce retirée');
const q53 = mkOrder(53, Q, '60.00');
await hook(q53); ok(code(Q) === 'AV-GIFT-53' && activeGifts().filter((c) => /AV-GIFT-5[23]/.test(c)).length === 1, 'carte recomplétée : une seule pièce active (jamais deux)');
Object.assign(db.orders[k43], { currentSubtotalPriceSet: { shopMoney: { amount: '45.00' } }, displayFinancialStatus: 'PARTIALLY_REFUNDED' });
r = await refund(k43); ok(r.body.credited === -50 && stamps(K) === 3, 'remboursement partiel à 45 € : -50, tampon gardé');
r = await refund(k43); ok(r.body.credited === 0, 'remboursement rejoué : sans effet');
db.orders[k43].currentSubtotalPriceSet = { shopMoney: { amount: '30.00' } };
r = await refund(k43); ok(stamps(K) === 2 && r.body.credited === -150, 'remboursement sous 40 € : tampon retiré');
db.orders[k[1]].cancelledAt = '2026-10-02T10:00:00Z';
r = await hook(k[1], 'orders/cancelled'); ok(r.body.credited === -500 && stamps(K) === 1, 'commande annulée après crédit : points et tampon repris');
const v1 = mkOrder(60, V, '80.00');
db.failSave.add(V);
r = await hook(v1); ok(r.code === 200 && r.body.credited === 800 && stamps(V) === 1, 'conflit d’enregistrement : relance interne, crédité une fois');

// ---------- parrainage ----------
section('parrainage');
await call('me', { sub: S1 });
const refI = ref(I);
const o11 = mkOrder(11, L, '55.00', { customAttributes: [{ key: '_club_ref', value: refI.toLowerCase() }] });
let pI = pts(I);
r = await hook(o11); ok(r.body.credited === 550 && r.body.referral?.sponsor === I && pts(I) === pI + 2000, 'filleule : +550, marraine +2000');
r = await hook(o11); ok(pts(I) === pI + 2000, 'webhook rejoué : marraine pas recréditée');
pI = pts(I);
const m70 = mkOrder(70, M, '50.00', { customAttributes: [{ key: '_club_ref', value: refI }], displayFulfillmentStatus: 'UNFULFILLED' });
const m71 = mkOrder(71, M, '50.00', { customAttributes: [{ key: '_club_ref', value: refI }] });
r = await hook(m71); ok(!r.body.referral && pts(I) === pI, '2e commande expédiée avant la 1re : pas de parrainage');
db.orders[m70].displayFulfillmentStatus = 'FULFILLED';
r = await hook(m70); ok(r.body.referral?.state === 'credited' && pts(I) === pI + 2000, 'la vraie 1re commande expédiée ensuite : parrainage crédité');
db.orders[m70].currentSubtotalPriceSet = { shopMoney: { amount: '0.00' } };
db.orders[m70].displayFinancialStatus = 'REFUNDED';
r = await refund(m70); ok(r.body.referral?.state === 'reversed' && pts(I) === pI, 'filleule remboursée : parrainage repris');
r = await refund(m70); ok(pts(I) === pI, 'reprise une seule fois');
const n80 = mkOrder(80, N, '45.00', { customAttributes: [{ key: '_club_ref', value: refI }] });
db.failSave.add(I);
r = await hook(n80); ok(r.code === 200 && pts(I) === pI + 2000, 'enregistrement de la marraine en conflit : relancé, crédité une fois');
await hook(n80); ok(pts(I) === pI + 2000, 'rejoué : toujours une seule fois');
const z90 = mkOrder(90, Z, '30.00', { customAttributes: [{ key: '_club_ref', value: refI }] });
pI = pts(I);
r = await hook(z90); ok(!r.body.referral && pts(I) === pI, 'filleule sous 40 € : pas de parrainage');
db.customers[S2].tags.push(`clubref${ref(S1)}`);
const p91 = mkOrder(91, P, '60.00', { customAttributes: [{ key: '_club_ref', value: ref(S1) }] });
const pS1 = pts(S1);
r = await hook(p91); ok(!r.body.referral && pts(S1) === pS1 && db.customers[P].tags.includes('club-ref-conflit'), 'code porté par deux clientes : aucun crédit, tag club-ref-conflit');
db.customers[S2].tags = [];
db.customers[S1].defaultAddress = { address1: '9 Avenue des Fleurs', zip: '98000' };
cust(C(20), 'Ursule');
const u92 = mkOrder(92, C(20), '60.00', { customAttributes: [{ key: '_club_ref', value: ref(S1) }], shippingAddress: { address1: '9, avenue des fleurs', zip: '98000' } });
r = await hook(u92); ok(!r.body.referral && pts(S1) === pS1 && db.customers[C(20)].tags.includes('club-ref-suspect'), 'même adresse que la marraine : aucun crédit, tag club-ref-suspect');
cust(C(21), 'Yasmine');
const y93 = mkOrder(93, C(21), '60.00', { customAttributes: [{ key: '_club_ref', value: 'newsletter' }] });
r = await hook(y93); ok(r.body.credited === 600 && !r.body.referral, 'attribut ?ref= étranger : ignoré');

// ---------- échanges ----------
section('échanges');
db.customers[I].mf.points.value = '60000';
r = await call('redeem', { method: 'POST', sub: I, body: { reward: 'brode' } });
ok(r.code === 200 && r.body.request && r.body.points === 52000 && db.customers[I].tags.includes('club-demande') && db.customers[I].tags.includes('club-demande-brode'), 'grande récompense : -8 000, tags club-demande(-brode)');
db.customers[I].tags = db.customers[I].tags.filter((t) => !t.startsWith('club-demande'));
await call('me', { sub: I }); ok(db.customers[I].tags.includes('club-demande-brode'), 'tag de demande perdu : réparé');
db.customers[I].mf.points.value = '49999';
r = await call('redeem', { method: 'POST', sub: I, body: { reward: 'prenom' } }); ok(r.code === 400, 'prénom refusé à 49 999 points');
r = await call('me', { sub: I }); ok(r.body.rewards.find((x) => x.id === 'prenom').points === 50000 && !r.body.rewards.some((x) => ['yacht', 'diner', 'vespa', 'monaco'].includes(x.id)), 'barème : prénom à 50 000 ; Vespa, Monaco, yacht et dîner retirés');
r = await call('redeem', { method: 'POST', sub: I, body: { reward: 'shipping' } });
ok(r.code === 200 && r.body.points === 48999 && /^CLUB-[A-Z2-9]{6}$/.test(r.body.code) && r.body.codes[0].code === r.body.code, 'échange livraison : -1000, code affiché dans « mes codes »');
ok(r.body.total >= 3000, 'le cumul ne baisse pas après échange');
db.failDiscount = true;
r = await call('redeem', { method: 'POST', sub: I, body: { reward: 'eur10' } });
const after = await call('me', { sub: I });
ok(r.code === 422 && after.body.points === 48999 && !after.body.codes.some((c) => !db.discounts.some((d) => d.code === c.code)), 'code refusé par Shopify : points rendus, aucun code fantôme');
db.customers[I].mf.points.value = '2500';
r = await call('redeem', { method: 'POST', sub: I, body: { reward: 'grandprix' } });
ok(r.body.ticket && r.body.tickets === 1 && r.body.points === 1500 && db.customers[I].tags.includes('club-tirage'), 'ticket : -1000, tag club-tirage');
r = await call('redeem', { method: 'POST', sub: I, body: { reward: 'grandprix' } }); ok(r.body.tickets === 2 && db.customers[I].mf.tickets.value === '2', 'plusieurs tickets possibles');
r = await call('redeem', { method: 'POST', sub: I, body: { reward: 'grandprix' } }); ok(r.code === 400, 'pas de ticket sans 1000 points');
db.customers[I].mf.points.value = '1600';
const [a, b] = await Promise.all([call('redeem', { method: 'POST', sub: I, body: { reward: 'eur5' } }), call('redeem', { method: 'POST', sub: I, body: { reward: 'eur5' } })]);
ok([a.code, b.code].sort().join() === '200,400' && pts(I) === 100, 'double clic : un seul échange passe');

// ---------- page de remerciement ----------
section('page de remerciement');
const t1 = mkOrder(100, L, '60.00', { displayFulfillmentStatus: 'UNFULFILLED' });
r = await call('thankyou', { token: jwt(L), url: `/api/thankyou?order=${t1}` }); ok(r.body.counts && r.body.slot === 2, 'tampon annoncé à la bonne place');
r = await call('thankyou', { token: jwt(I), url: `/api/thankyou?order=${t1}` }); ok(r.code === 403, 'commande d’une autre cliente : refusée');
r = await call('thankyou', { token: jwt(), url: `/api/thankyou?order=${o10}` }); ok(r.code === 403, 'sans compte, vieille commande : refusée');
const t2 = mkOrder(101, L, '30.00', { displayFulfillmentStatus: 'UNFULFILLED' });
r = await call('thankyou', { token: jwt(L), url: `/api/thankyou?order=${t2}` }); ok(r.body.counts === false, '30 € : aucun tampon annoncé');
const t3 = mkOrder(102, L, '60.00', { displayFinancialStatus: 'PENDING', displayFulfillmentStatus: 'UNFULFILLED' });
r = await call('thankyou', { token: jwt(L), url: `/api/thankyou?order=${t3}` }); ok(r.body.counts === false, 'paiement en attente : aucun tampon annoncé');
r = await call('thankyou', { url: `/api/thankyou?order=${t1}` }); ok(r.code === 401, 'sans jeton : 401');

// ---------- anciennes données ----------
section('migration des anciennes données');
const legacy = db.customers[P];
legacy.mf = {
  points: { value: '1650', digest: 'p1' }, points_total: { value: '1650', digest: 'p2' }, stamps: { value: '3', digest: 'p3' },
  reward_code: { value: 'AV-GIFT-902', digest: 'p4' }, ref: { value: 'AV000006', digest: 'p5' },
  actions: { value: JSON.stringify({ join: '2026-09-28' }), digest: 'p6' },
  history: { value: JSON.stringify([
    { d: '2026-09-30', p: 500, l: 'Commande #902 · tampon 3/3 — pièce offerte', o: '#902', s: 1, c: 'AV-GIFT-902' },
    { d: '2026-09-29', p: 500, l: 'Commande #901 · tampon 2/3', o: '#901', s: 1 },
    { d: '2026-09-28', p: 450, l: 'Commande #900 · tampon 1/3', o: '#900', s: 1 },
    { d: '2026-09-28', p: 200, l: 'Bienvenue au club' }
  ]), digest: 'p7' }
};
legacy.tags.push('clubrefAV000006');
db.discounts.push({ code: 'AV-GIFT-902', customerGets: {}, context: {} });
db.orders[O(900)] = { ...db.orders[p91], name: '#900', customer: P, customAttributes: [], createdAt: '2026-09-27T10:00:00Z', currentSubtotalPriceSet: { shopMoney: { amount: '45.00' } } };
r = await call('me', { sub: P });
const led = JSON.parse(legacy.mf.orders.value);
ok(r.body.points === 1650 && Object.keys(led).length === 3 && r.body.stampCode === 'AV-GIFT-902' && r.body.stamps === 3, 'registre reconstruit depuis l’historique, solde et pièce intacts');
r = await hook(O(900)); ok(r.body.credited === 0 && pts(P) === 1650, 'ancienne commande rejouée : pas recréditée');

// ---------- tâches planifiées ----------
section('tâches planifiées');
const paris = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
const todayTag = `bday${String(paris.getMonth() + 1).padStart(2, '0')}${String(paris.getDate()).padStart(2, '0')}`;
db.customers[Z].tags.push(todayTag);
db.customers[L].tags.push(todayTag);
db.broken.add(Z);
r = await call('birthdays'); ok(r.body.credited === 1 && r.body.failed.length === 1, 'anniversaire : une cliente en erreur n’empêche pas les autres');
r = await call('birthdays'); ok(r.body.credited === 0, 'une seule fois par an');
db.broken.delete(Z);
cust(C(30), 'Rose');
mkOrder(110, C(30), '90.00');
r = await call('reconcile'); ok(stamps(C(30)) === 1 && pts(C(30)) === 1100, 'rattrapage nocturne : commande sans webhook créditée');
r = await call('reconcile'); ok(pts(C(30)) === 1100, 'rattrapage rejoué : sans effet');

// ---------- proxy d'application (page du thème) ----------
section('proxy d’application');
const proxyUrl = (customer, { shop = 'test.myshopify.com', ts = Math.floor(Date.now() / 1000), forge } = {}) => {
  const p = { shop, path_prefix: '/apps/club', timestamp: String(ts), logged_in_customer_id: customer };
  const msg = Object.keys(p).sort().map((x) => `${x}=${p[x]}`).join('');
  const sig = forge ? '0'.repeat(64) : crypto.createHmac('sha256', 'secret').update(msg).digest('hex');
  return '/proxy/me?' + new URLSearchParams({ ...p, signature: sig });
};
r = await call('me', { url: proxyUrl('2') }); ok(r.code === 200 && r.body.firstName === 'Inès', 'cliente reconnue par la signature Shopify');
r = await call('me', { url: proxyUrl('2', { forge: true }) }); ok(r.code === 401, 'signature forgée refusée');
r = await call('me', { url: proxyUrl('') }); ok(r.code === 401, 'visiteuse non connectée refusée');
r = await call('me', { url: proxyUrl('2', { shop: 'autre.myshopify.com' }) }); ok(r.code === 401, 'autre boutique refusée');
r = await call('me', { url: proxyUrl('2', { ts: 1000 }) }); ok(r.code === 401, 'requête périmée refusée');
r = await call('action', { method: 'POST', url: proxyUrl('4'), body: { type: 'instagram' } }); ok(r.code === 200 && r.body.actions.find((x) => x.id === 'instagram').done, 'action Instagram créditée depuis la page');

console.log(`\n${pass} réussis, ${fail} en échec`);
process.exitCode = fail ? 1 : 0;
