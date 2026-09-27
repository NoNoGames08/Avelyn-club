import { fail } from './_lib/http.js';
import { preflight, customerFromToken, loadCustomer, saveCustomer, ensureJoined, addTags, publicState, json } from './_lib/club.js';

/**
 * GET /api/me — état du club pour la cliente connectée (extension de
 * l'espace client). La première visite l'inscrit : +points de bienvenue et
 * code de parrainage.
 */
export default async function handler(req, res) {
  if (preflight(req, res)) return;
  try {
    const id = customerFromToken(req);
    const c = await loadCustomer(id);
    const { extra, tags, joined } = ensureJoined(c);
    if (joined || extra.length) {
      await saveCustomer(c, { extra });
      if (tags.length) await addTags(c.id, tags);
    }
    return json(res, 200, { ...publicState(c), welcome: joined });
  } catch (error) {
    return fail(res, error);
  }
}
