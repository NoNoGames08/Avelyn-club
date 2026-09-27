import { HttpError, fail, str } from './_lib/http.js';
import { CLUB } from './_lib/club-config.js';
import { preflight, verifySessionToken, admin, json } from './_lib/club.js';

/**
 * GET /api/thankyou?order=<gid> — page de remerciement (extension de paiement).
 * Dit quel tampon cette commande va poser sur la carte, pour l'animation.
 * Fonctionne aussi pour un achat sans compte : Shopify rattache la commande
 * à la fiche cliente par l'e-mail, les tampons l'y attendent.
 *
 * Position = tampons déjà validés + commandes payées plus anciennes pas encore
 * expédiées + celle-ci — deux commandes coup sur coup n'affichent pas le même tampon.
 */
export default async function handler(req, res) {
  if (preflight(req, res)) return;
  try {
    verifySessionToken(req);
    const orderId = str(new URL(req.url, 'https://x').searchParams.get('order'), { max: 80 });
    if (!/^gid:\/\/shopify\/Order(Identity)?\/\d+$/.test(orderId)) throw new HttpError(400, 'Commande invalide.');
    const id = orderId.replace('OrderIdentity', 'Order');

    const { order } = await admin(
      `query($id: ID!) { order(id: $id) {
        name
        currentSubtotalPriceSet { shopMoney { amount } }
        customer {
          stamps: metafield(namespace: "loyalty", key: "stamps") { value }
          history: metafield(namespace: "loyalty", key: "history") { value }
          orders(first: 15, sortKey: CREATED_AT, reverse: true) {
            nodes { name cancelledAt displayFinancialStatus displayFulfillmentStatus currentSubtotalPriceSet { shopMoney { amount } } }
          }
        }
      } }`,
      { id }
    );
    if (!order) throw new HttpError(404, 'Commande introuvable.');
    const { goal } = CLUB.stamps;
    const counts = Number(order.currentSubtotalPriceSet.shopMoney.amount) > 0;
    const credited = parseInt(order.customer?.stamps?.value ?? '0', 10) || 0;
    let history = [];
    try { history = JSON.parse(order.customer?.history?.value || '[]'); } catch {}
    const done = new Set(history.map((h) => h.o).filter(Boolean));
    // Commandes de la plus récente à la plus ancienne : on part de celle-ci.
    const nodes = order.customer?.orders?.nodes || [];
    const from = Math.max(0, nodes.findIndex((o) => o.name === order.name));
    const PAID = ['PAID', 'PARTIALLY_REFUNDED', 'AUTHORIZED', 'PARTIALLY_PAID'];
    const pending = nodes.slice(from).filter((o) =>
      o.name !== order.name && !o.cancelledAt && !done.has(o.name) &&
      PAID.includes(o.displayFinancialStatus) && Number(o.currentSubtotalPriceSet.shopMoney.amount) > 0
    ).length;
    const position = credited + pending + (counts ? 1 : 0);
    const slot = counts ? ((position - 1) % goal) + 1 : 0;

    return json(res, 200, {
      counts,
      goal,
      slot,
      completes: counts && slot === goal,
      pointsPerEuro: CLUB.pointsPerEuro,
      points: counts ? Math.floor(Number(order.currentSubtotalPriceSet.shopMoney.amount)) * CLUB.pointsPerEuro : 0
    });
  } catch (error) {
    return fail(res, error);
  }
}
