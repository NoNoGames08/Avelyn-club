import crypto from 'node:crypto';
import { HttpError, fail, str } from './_lib/http.js';
import { json } from './_lib/club.js';
import { syncOrder } from './_lib/sync.js';

/**
 * POST /api/order — webhooks Shopify de l'app avelyn-fidelite (déclarés dans
 * shopify.app.toml) : orders/paid, orders/fulfilled, orders/updated,
 * orders/cancelled et refunds/create. Signature vérifiée avec le secret de
 * l'app (en-tête X-Shopify-Hmac-Sha256, corps brut).
 *
 * Tous les sujets font la même chose : relire la commande chez Shopify et la
 * rapprocher du registre de la cliente (api/_lib/sync.js). Points, tampon,
 * pièce offerte et parrainage suivent l'état RÉEL de la commande, quel que
 * soit l'ordre ou le nombre de fois où les webhooks arrivent. Le rattrapage
 * quotidien (api/reconcile) repasse sur les commandes récentes.
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
    return json(res, 200, await syncOrder(orderId));
  } catch (error) {
    return fail(res, error);
  }
}
