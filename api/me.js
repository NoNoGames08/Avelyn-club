import { fail } from './_lib/http.js';
import { preflight, customerFromToken, loadCustomer, saveCustomer, ensureJoined, safeTags, withRetry, publicState, json } from './_lib/club.js';

/**
 * GET /api/me — état du club pour la cliente connectée (extension de
 * l'espace client). La première visite l'inscrit : +points de bienvenue et
 * code de parrainage.
 */
export default async function handler(req, res) {
  if (preflight(req, res)) return;
  try {
    const id = customerFromToken(req);
    let joined = false;
    let tags = [];
    const c = await withRetry(async () => {
      const fresh = await loadCustomer(id);
      const r = await ensureJoined(fresh);
      joined = r.joined;
      tags = r.tags;
      if (r.joined || r.extra.length || fresh.migrated) await saveCustomer(fresh, { extra: r.extra });
      return fresh;
    });
    await safeTags(c.id, tags);
    return json(res, 200, { ...publicState(c), welcome: joined });
  } catch (error) {
    return fail(res, error);
  }
}
