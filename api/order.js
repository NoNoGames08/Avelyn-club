import crypto from 'node:crypto';
import { HttpError, fail, str } from './_lib/http.js';
import { CLUB } from './_lib/club-config.js';
import { admin, loadCustomer, saveCustomer, ensureJoined, credit, addTags, json } from './_lib/club.js';

/**
 * POST /api/order — webhook Shopify « orders/paid » de l'app
 * avelyn-fidelite (déclaré dans shopify.app.toml). Signature vérifiée avec
 * le secret de l'app (en-tête X-Shopify-Hmac-Sha256, corps brut).
 *
 * - points d'achat : sous-total payé (après remises, hors livraison) × barème
 * - parrainage : attribut de panier _club_ref posé par le thème quand la
 *   visiteuse arrive par un lien ?ref= — crédité à la marraine si c'est la
 *   première commande de la filleule
 * La commande est relue chez Shopify (payée, non annulée) et chaque commande
 * n'est créditée qu'une fois : les renvois du webhook sont sans effet.
 */
export const config = { api: { bodyParser: false } };

async function rawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body && typeof req.body === 'object') throw new HttpError(500, 'Corps déjà décodé : impossible de vérifier la signature (bodyParser).');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
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
    const orderId = str(payload.admin_graphql_api_id || (payload.id ? `gid://shopify/Order/${payload.id}` : ''), { max: 80 });
    if (!/^gid:\/\/shopify\/Order\/\d+$/.test(orderId)) throw new HttpError(400, 'orderId invalide.');

    const { order } = await admin(
      `query($id: ID!) { order(id: $id) {
        id name cancelledAt displayFinancialStatus
        currentSubtotalPriceSet { shopMoney { amount } }
        customAttributes { key value }
        customer { id }
      } }`,
      { id: orderId }
    );
    if (!order?.customer) return json(res, 200, { skipped: 'sans cliente' });
    if (order.cancelledAt) return json(res, 200, { skipped: 'annulée' });
    if (!['PAID', 'PARTIALLY_REFUNDED', 'PARTIALLY_PAID'].includes(order.displayFinancialStatus)) return json(res, 200, { skipped: 'non payée' });

    const c = await loadCustomer(order.customer.id);
    if (c.history.some((h) => h.o === order.name)) return json(res, 200, { skipped: 'déjà créditée' });

    const { extra, tags } = ensureJoined(c);
    const euros = Math.floor(Number(order.currentSubtotalPriceSet.shopMoney.amount) || 0);
    const earned = euros * CLUB.pointsPerEuro;
    if (earned > 0) credit(c, earned, `Commande ${order.name}`, { o: order.name });
    else c.history.unshift({ d: new Date().toISOString().slice(0, 10), p: 0, l: `Commande ${order.name}`, o: order.name });

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
    return json(res, 200, { credited: earned, referral });
  } catch (error) {
    return fail(res, error);
  }
}
