import { HttpError, fail, str } from './_lib/http.js';
import { CLUB } from './_lib/club-config.js';
import { preflight, verifySessionToken, admin, json } from './_lib/club.js';
import { orderBase } from './_lib/sync.js';

/**
 * GET /api/thankyou?order=<gid> — page de remerciement (extension de paiement).
 * Dit quel tampon cette commande posera sur la carte À L'EXPÉDITION, pour
 * l'animation. Mêmes règles que le serveur (api/_lib/sync.js) : commande payée,
 * au moins minSubtotal € hors cartes cadeaux.
 *
 * Position = tampons déjà validés + commandes payées plus anciennes pas encore
 * créditées + celle-ci. `completes` seulement si cette commande fait vraiment
 * naître une nouvelle pièce (pas si une pièce a déjà été donnée pour cette carte).
 *
 * Confidentialité : une cliente connectée ne peut interroger que ses propres
 * commandes ; sans compte, seulement une commande passée il y a moins de 6 h.
 */
const ORDER_FIELDS = `name createdAt cancelledAt displayFinancialStatus
  currentSubtotalPriceSet { shopMoney { amount } }
  lineItems(first: 100) { nodes { isGiftCard currentQuantity discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } } } }`;
const PAID = ['PAID', 'PARTIALLY_REFUNDED'];

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  try {
    const session = verifySessionToken(req);
    const orderId = str(new URL(req.url, 'https://x').searchParams.get('order'), { max: 80 });
    if (!/^gid:\/\/shopify\/Order(Identity)?\/\d+$/.test(orderId)) throw new HttpError(400, 'Commande invalide.');
    const id = orderId.replace('OrderIdentity', 'Order');

    let order = null;
    // La commande peut ne pas être encore lisible à l'instant où la page s'affiche.
    for (let i = 0; i < 3 && !order; i += 1) {
      if (i) await new Promise((r) => setTimeout(r, 1200));
      ({ order } = await admin(
        `query($id: ID!) { order(id: $id) {
          ${ORDER_FIELDS}
          customer {
            id
            stamps: metafield(namespace: "loyalty", key: "stamps") { value }
            ledger: metafield(namespace: "loyalty", key: "orders") { value }
            actions: metafield(namespace: "loyalty", key: "actions") { value }
            orders(first: 15, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER_FIELDS} } }
          }
        } }`,
        { id }
      ));
    }
    if (!order) throw new HttpError(404, 'Commande introuvable.');
    if (session.sub && order.customer?.id && session.sub !== order.customer.id) throw new HttpError(403, 'Commande d’une autre cliente.');
    if (!session.sub && Date.now() - Date.parse(order.createdAt) > 6 * 3600e3) throw new HttpError(403, 'Commande trop ancienne.');

    const { goal, minSubtotal } = CLUB.stamps;
    const qualifies = (o) => !o.cancelledAt && PAID.includes(o.displayFinancialStatus) && orderBase(o) >= minSubtotal;
    const counts = Boolean(order.customer) && qualifies(order);
    const parse = (raw, fallback) => { try { return JSON.parse(raw || ''); } catch { return fallback; } };
    const credited = parseInt(order.customer?.stamps?.value ?? '0', 10) || 0;
    const ledger = parse(order.customer?.ledger?.value, {});
    const gifts = (parse(order.customer?.actions?.value, {}).gifts || []).length;
    const nodes = order.customer?.orders?.nodes || [];
    const from = Math.max(0, nodes.findIndex((o) => o.name === order.name));
    const pending = nodes.slice(from).filter((o) => o.name !== order.name && !ledger[o.name] && qualifies(o)).length;
    const position = credited + pending + (counts ? 1 : 0);
    const slot = counts ? ((position - 1) % goal) + 1 : 0;

    return json(res, 200, {
      counts,
      goal,
      slot,
      completes: counts && slot === goal && Math.floor(position / goal) > gifts,
      minSubtotal
    });
  } catch (error) {
    return fail(res, error);
  }
}
