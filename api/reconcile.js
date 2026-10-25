import { HttpError, fail } from './_lib/http.js';
import { admin, json } from './_lib/club.js';
import { syncOrder } from './_lib/sync.js';

/**
 * GET /api/reconcile — tâche planifiée Vercel (vercel.json → crons), chaque
 * nuit : repasse sur toutes les commandes modifiées ces 3 derniers jours. Un
 * webhook perdu, refusé ou arrivé trop tôt est ainsi rattrapé ; sur une
 * commande déjà à jour, le rapprochement ne change rien.
 */
export default async function handler(req, res) {
  try {
    if (process.env.CRON_SECRET && (req.headers.authorization || '') !== `Bearer ${process.env.CRON_SECRET}`) throw new HttpError(401, 'Non autorisé.');
    const since = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
    let cursor = null;
    const result = { checked: 0, credited: 0, failed: [] };
    for (let page = 0; page < 20; page += 1) {
      const data = await admin(
        `query($q: String!, $after: String) { orders(first: 50, after: $after, query: $q, sortKey: UPDATED_AT) { pageInfo { hasNextPage endCursor } nodes { id name } } }`,
        { q: `updated_at:>=${since}`, after: cursor }
      );
      for (const o of data.orders.nodes) {
        result.checked += 1;
        try {
          const r = await syncOrder(o.id);
          if (r.credited) result.credited += 1;
        } catch (error) {
          console.error('rattrapage', o.name, error.message);
          result.failed.push(o.name);
        }
      }
      if (!data.orders.pageInfo.hasNextPage) break;
      cursor = data.orders.pageInfo.endCursor;
    }
    return json(res, 200, result);
  } catch (error) {
    return fail(res, error);
  }
}
