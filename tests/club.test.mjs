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
const I = 'gid://shopify/Customer/2', L = 'gid://shopify/Customer/1', K = 'gid://shopify/Customer/3';
const baseOrder = (name, customer, amount = '72.50', extra = {}) => ({
  name, customer, cancelledAt: null, displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED',
  discountCodes: [], customAttributes: [], currentSubtotalPriceSet: { shopMoney: { amount } }, ...extra
});
const db = {
  customers: {
    [L]: { firstName: 'Léa', numberOfOrders: 1, tags: [], sub: 'NOT_SUBSCRIBED', mf: {} },
    [I]: { firstName: 'Inès', numberOfOrders: 3, tags: [], sub: 'NOT_SUBSCRIBED', mf: {} },
    [K]: { firstName: 'Kim', numberOfOrders: 3, tags: [], sub: 'NOT_SUBSCRIBED', mf: { stamps: { value: '2', digest: 'k1' } } }
  },
  orders: {
    'gid://shopify/Order/10': baseOrder('#1010', I),
    'gid://shopify/Order/11': baseOrder('#1011', L, '55.00')
  },
  discounts: [], used: new Set(), n: 0, failNextSave: false
};
const mf = (c, k) => (c.mf[k] ? { value: c.mf[k].value, compareDigest: c.mf[k].digest } : null);
const resp = (data) => new Response(JSON.stringify({ data }));

globalThis.fetch = async (url, opts) => {
  if (url.includes('access_token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 86399 }));
  const { query: q, variables: v } = JSON.parse(opts.body);
  if (q.includes('ClubCustomer')) {
    const c = db.customers[v.id];
    return resp({ customer: { id: v.id, firstName: c.firstName, numberOfOrders: c.numberOfOrders, tags: c.tags, emailMarketingConsent: { marketingState: c.sub },
      points: mf(c, 'points'), pointsTotal: mf(c, 'points_total'), actions: mf(c, 'actions'), history: mf(c, 'history'), birthday: mf(c, 'birthday'),
      ref: mf(c, 'ref'), stamps: mf(c, 'stamps'), rewardCode: mf(c, 'reward_code') } });
  }
  if (q.includes('metafieldsSet')) {
    if (db.failNextSave) { db.failNextSave = false; return resp({ metafieldsSet: { metafields: [], userErrors: [{ field: ['x'], message: 'stale', code: 'STALE_OBJECT' }] } }); }
    const errs = [];
    for (const m of v.metafields) {
      const cur = db.customers[m.ownerId].mf[m.key];
      if ('compareDigest' in m && (m.compareDigest ?? null) !== (cur?.digest ?? null)) errs.push({ field: ['metafields'], message: 'stale', code: 'STALE_OBJECT' });
    }
    if (!errs.length) for (const m of v.metafields) db.customers[m.ownerId].mf[m.key] = { value: m.value, digest: 'd' + ++db.n };
    return resp({ metafieldsSet: { metafields: [], userErrors: errs } });
  }
  if (q.includes('tagsAdd')) { db.customers[v.id].tags.push(...v.tags); return resp({ tagsAdd: { userErrors: [] } }); }
  if (q.includes('tagsRemove')) { const c = db.customers[v.id]; c.tags = c.tags.filter((t) => !v.tags.includes(t)); return resp({ tagsRemove: { userErrors: [] } }); }
  if (q.includes('customerEmailMarketingConsentUpdate')) { db.customers[v.input.customerId].sub = 'SUBSCRIBED'; return resp({ customerEmailMarketingConsentUpdate: { userErrors: [] } }); }
  if (q.includes('codeDiscountNodeByCode')) {
    const d = db.discounts.find((x) => x.code.toUpperCase() === v.code.toUpperCase() && !x.deleted);
    return resp({ codeDiscountNodeByCode: d ? { id: 'disc-' + d.code, codeDiscount: { asyncUsageCount: db.used.has(d.code) ? 1 : 0 } } : null });
  }
  if (q.includes('discountCodeDelete')) { db.discounts.find((x) => 'disc-' + x.code === v.id).deleted = true; return resp({ discountCodeDelete: { deletedCodeDiscountId: v.id, userErrors: [] } }); }
  if (q.includes('discountCodeBasicCreate')) {
    if (db.discounts.some((x) => x.code === v.d.code && !x.deleted)) return resp({ discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ field: ['code'], message: 'Code must be unique' }] } });
    db.discounts.push(v.d); return resp({ discountCodeBasicCreate: { codeDiscountNode: { id: 'x' }, userErrors: [] } });
  }
  if (q.includes('discountCodeFreeShippingCreate')) { db.discounts.push(v.d); return resp({ discountCodeFreeShippingCreate: { codeDiscountNode: { id: 'y' }, userErrors: [] } }); }
  if (q.includes('order(id') && q.includes('orders(first')) {
    const o = db.orders[v.id]; const c = db.customers[o.customer];
    const nodes = Object.values(db.orders).filter((x) => x.customer === o.customer).reverse()
      .map((x) => ({ name: x.name, cancelledAt: x.cancelledAt, displayFinancialStatus: x.displayFinancialStatus, displayFulfillmentStatus: x.displayFulfillmentStatus, currentSubtotalPriceSet: x.currentSubtotalPriceSet }));
    return resp({ order: { name: o.name, currentSubtotalPriceSet: o.currentSubtotalPriceSet, customer: { stamps: mf(c, 'stamps'), history: mf(c, 'history'), orders: { nodes } } } });
  }
  if (q.includes('order(id')) { const o = db.orders[v.id]; return resp({ order: o && { id: v.id, ...o, customer: { id: o.customer } } }); }
  if (q.includes('customers(first')) {
    const tag = v.q.replace('tag:', '');
    return resp({ customers: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: Object.entries(db.customers).filter(([, c]) => c.tags.includes(tag)).map(([id]) => ({ id })) } });
  }
  throw new Error('requête non simulée : ' + q.slice(0, 80));
};

// ---------- appels ----------
const jwt = (sub) => {
  const h = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');
  const b = Buffer.from(JSON.stringify({ ...(sub ? { sub } : {}), aud: 'cid', exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
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
const order = (id) => call('order', { method: 'POST', body: { orderId: id } });
const refund = (id) => call('order', { method: 'POST', body: { orderId: id }, topic: 'refunds/create' });
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else fail++; console.log((cond ? '✓ ' : '✗ ') + msg); };

// ---------- scénarios ----------
let r = await call('me', { sub: I });
ok(r.code === 200 && r.body.points === 200 && r.body.welcome, 'inscription : +200');
ok(r.body.referral.code === 'AV000002' && db.customers[I].tags.includes('clubrefAV000002') && db.customers[I].tags.includes('club-plage'), 'code de parrainage, tags');
r = await call('me', { sub: I }); ok(r.body.points === 200 && !r.body.welcome, 'pas de double bienvenue');
r = await call('me', {}); ok(r.code === 401, 'sans session : 401');
r = await call('me', { token: 'a.b.c' }); ok(r.code === 401, 'jeton falsifié : 401');
r = await call('action', { method: 'POST', sub: I, body: { type: 'newsletter' } }); ok(r.body.points === 500 && db.customers[I].sub === 'SUBSCRIBED', 'newsletter : +300 et inscrite');
r = await call('action', { method: 'POST', sub: I, body: { type: 'newsletter' } }); ok(r.body.already, 'newsletter une seule fois');
r = await call('action', { method: 'POST', sub: I, body: { type: 'birthday', date: '2003-01-15' } }); ok(r.body.points === 600 && db.customers[I].tags.includes('bday0115'), 'anniversaire : +100, tag');
r = await call('redeem', { method: 'POST', sub: I, body: { reward: 'eur5' } }); ok(r.code === 400, 'échange refusé sous le seuil');
r = await order('gid://shopify/Order/10'); ok(r.body.credited === 720 && r.body.stamps === 1, 'commande expédiée 72,50 € : +720, tampon 1');
r = await order('gid://shopify/Order/10'); ok(r.body.skipped === 'déjà créditée', 'une commande ne compte qu\'une fois');
r = await call('redeem', { method: 'POST', sub: I, body: { reward: 'shipping' } });
ok(r.code === 200 && r.body.points === 320 && /^CLUB-[A-Z2-9]{6}$/.test(r.body.code), 'échange livraison : -1000 et code');
ok(db.discounts.at(-1).context.customers.add[0] === I && db.discounts.at(-1).usageLimit === 1, 'code réservé à la cliente, usage unique');
ok(r.body.total === 1320, 'le cumul ne baisse pas après échange');
db.orders['gid://shopify/Order/11'].customAttributes = [{ key: '_club_ref', value: 'av000002' }];
r = await order('gid://shopify/Order/11'); ok(r.body.credited === 550 && r.body.referral === I, 'filleule : +550, parrainage détecté');
r = await call('me', { sub: I }); ok(r.body.points === 1320, 'marraine : +1000');
db.orders['gid://shopify/Order/12'] = baseOrder('#1012', I, '72.50', { displayFinancialStatus: 'PENDING', displayFulfillmentStatus: 'UNFULFILLED' });
r = await order('gid://shopify/Order/12'); ok(r.body.skipped === 'non payée', 'commande non payée ignorée');
db.orders['gid://shopify/Order/13'] = baseOrder('#1013', I, '200');
await order('gid://shopify/Order/13');
r = await call('me', { sub: I }); ok(r.body.tier.id === 'terrasse' && db.customers[I].tags.includes('club-terrasse') && !db.customers[I].tags.includes('club-plage'), 'palier Terrasse, tags à jour');
ok(db.customers[I].mf.stamps.value === '2', 'deux tampons après deux commandes expédiées');
db.orders['gid://shopify/Order/14'] = baseOrder('#1014', I, '72.50', { displayFulfillmentStatus: 'PARTIALLY_FULFILLED' });
r = await order('gid://shopify/Order/14'); ok(r.body.skipped === 'pas encore expédiée en entier', 'expédition partielle : pas de tampon');
r = await call('thankyou', { token: jwt(), url: '/api/thankyou?order=gid://shopify/Order/14' }); ok(r.body.slot === 3 && r.body.completes, 'remerciement : 3e tampon annoncé');
r = await call('thankyou', { url: '/api/thankyou?order=gid://shopify/Order/14' }); ok(r.code === 401, 'remerciement sans jeton : 401');
db.orders['gid://shopify/Order/14'].displayFulfillmentStatus = 'FULFILLED';
const nd = db.discounts.length;
r = await order('gid://shopify/Order/14');
ok(r.body.stamps === 3 && r.body.giftCode === 'AV-GIFT-1014' && db.discounts.length === nd + 1, '3e tampon : code pièce offerte');
const g = db.discounts.at(-1);
ok(g.customerGets.value.discountAmount.amount === '75.00' && g.customerGets.items.collections.add[0].endsWith('710939246934'), 'code : 75 € max sur Cadeaux fidélité');
db.orders['gid://shopify/Order/15'] = baseOrder('#1015', I, '72.50', { discountCodes: ['av-gift-1014'] });
await order('gid://shopify/Order/15');
ok(db.customers[I].mf.reward_code.value === '-' && db.customers[I].mf.stamps.value === '4', 'code utilisé : « - », nouvelle carte');
db.orders['gid://shopify/Order/16'] = baseOrder('#1016', I, '0.00');
await order('gid://shopify/Order/16'); ok(db.customers[I].mf.stamps.value === '4', 'commande à 0 € : pas de tampon');
r = await call('order', { method: 'POST', body: { orderId: 'gid://shopify/Order/10' }, badsig: true }); ok(r.code === 401, 'webhook mal signé : 401');

// anti-contournement
db.orders['gid://shopify/Order/20'] = baseOrder('#1020', K);
db.failNextSave = true;
r = await order('gid://shopify/Order/20'); ok(r.code === 409, 'conflit d\'enregistrement → relance');
r = await order('gid://shopify/Order/20'); ok(r.body.giftCode === 'AV-GIFT-1020' && db.discounts.filter((d) => d.code === 'AV-GIFT-1020').length === 1, 'relance : code créé une seule fois');
Object.assign(db.orders['gid://shopify/Order/20'], { currentSubtotalPriceSet: { shopMoney: { amount: '30.00' } }, displayFinancialStatus: 'PARTIALLY_REFUNDED' });
r = await refund('gid://shopify/Order/20'); ok(r.body.removedPoints === -420 && r.body.stamps === 3, 'remboursement partiel : -420, tampon gardé');
r = await refund('gid://shopify/Order/20'); ok(r.body.skipped === 'rien à reprendre', 'remboursement renvoyé : sans effet');
db.orders['gid://shopify/Order/20'].currentSubtotalPriceSet = { shopMoney: { amount: '0.00' } };
r = await refund('gid://shopify/Order/20'); ok(r.body.stamps === 2 && r.body.revoked === 'deleted' && db.customers[K].mf.reward_code.value === '-', 'remboursement total : tampon et code retirés');
db.orders['gid://shopify/Order/21'] = baseOrder('#1021', K);
r = await order('gid://shopify/Order/21'); ok(r.body.giftCode === 'AV-GIFT-1021', 'nouveau 3e tampon : nouveau code');
db.used.add('AV-GIFT-1021');
db.orders['gid://shopify/Order/21'].currentSubtotalPriceSet = { shopMoney: { amount: '0.00' } };
r = await refund('gid://shopify/Order/21'); ok(r.body.revoked === 'used' && JSON.parse(db.customers[K].mf.actions.value).giftDebt === 1, 'pièce utilisée puis remboursement : dette');
db.orders['gid://shopify/Order/22'] = baseOrder('#1022', K);
r = await order('gid://shopify/Order/22'); ok(r.body.giftCode === null && JSON.parse(db.customers[K].mf.actions.value).giftDebt === 0, 'carte recomplétée : pas de 2e pièce');

// récompenses démesurées
db.customers[I].mf.points = { value: '60000', digest: db.customers[I].mf.points.digest };
const nd2 = db.discounts.length;
r = await call('redeem', { method: 'POST', sub: I, body: { reward: 'brode' } });
ok(r.code === 200 && r.body.request && r.body.points === 58400 && db.discounts.length === nd2 && db.customers[I].tags.includes('club-demande'), 'récompense démesurée : -1 600, balise club-demande, aucun code');
ok(r.body.history[0].l === 'Demande : Une casquette brodée à votre prénom', 'demande tracée dans l\'historique');
db.customers[I].mf.points = { value: '23999', digest: db.customers[I].mf.points.digest };
r = await call('redeem', { method: 'POST', sub: I, body: { reward: 'vespa' } }); ok(r.code === 400, 'Vespa refusée à 23 999 points');
r = await call('me', { sub: I }); ok(r.body.rewards.find((x) => x.id === 'vespa').points === 24000 && !r.body.rewards.some((x) => x.id === 'yacht' || x.id === 'diner'), 'barème : Vespa à 24 000 (2 400 € dépensés), yacht et dîner retirés');

// page du thème, via le proxy d'application Shopify
const proxyUrl = (customer, { shop = 'test.myshopify.com', ts = Math.floor(Date.now() / 1000), forge } = {}) => {
  const p = { shop, path_prefix: '/apps/club', timestamp: String(ts), logged_in_customer_id: customer };
  const msg = Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join('');
  const sig = forge ? '0'.repeat(64) : crypto.createHmac('sha256', 'secret').update(msg).digest('hex');
  return '/proxy/me?' + new URLSearchParams({ ...p, signature: sig });
};
r = await call('me', { url: proxyUrl('2') }); ok(r.code === 200 && r.body.firstName === 'Inès', 'proxy : cliente reconnue par la signature Shopify');
r = await call('me', { url: proxyUrl('2', { forge: true }) }); ok(r.code === 401, 'proxy : signature forgée refusée');
r = await call('me', { url: proxyUrl('') }); ok(r.code === 401, 'proxy : visiteuse non connectée refusée');
r = await call('me', { url: proxyUrl('2', { shop: 'autre.myshopify.com' }) }); ok(r.code === 401, 'proxy : autre boutique refusée');
r = await call('me', { url: proxyUrl('2', { ts: 1000 }) }); ok(r.code === 401, 'proxy : requête périmée refusée');
r = await call('action', { method: 'POST', url: proxyUrl('1'), body: { type: 'tiktok' } }); ok(r.code === 200 && r.body.actions.find((a) => a.id === 'tiktok').done, 'proxy : action TikTok créditée depuis la page');
r = await call('redeem', { method: 'POST', url: proxyUrl('1'), body: { reward: 'shipping' } });
ok(r.code === 200 || r.code === 400, 'proxy : échange accepté par la route');

// anniversaire
const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
db.customers[L].tags.push(`bday${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`);
r = await call('birthdays'); ok(r.body.credited === 1, 'anniversaire du jour crédité');
r = await call('birthdays'); ok(r.body.credited === 0, 'une seule fois par an');

// double clic
db.customers[I].mf.points.value = '1600';
const [a, b] = await Promise.all([call('redeem', { method: 'POST', sub: I, body: { reward: 'eur5' } }), call('redeem', { method: 'POST', sub: I, body: { reward: 'eur5' } })]);
ok([a.code, b.code].sort().join() === '200,409', 'double clic : un seul échange passe');

console.log(`\n${pass} réussis, ${fail} en échec`);
process.exitCode = fail ? 1 : 0;
