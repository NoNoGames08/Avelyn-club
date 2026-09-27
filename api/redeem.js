import { HttpError, fail, readBody, str } from './_lib/http.js';
import { CLUB } from './_lib/club-config.js';
import { preflight, customerFromToken, loadCustomer, saveCustomer, credit, newCode, createDiscount, publicState, json } from './_lib/club.js';

/**
 * POST /api/redeem { reward } — échange des points contre un code
 * personnel à usage unique. Les points sont retirés AVANT la création du
 * code (compareDigest empêche un double échange) et rendus si Shopify
 * refuse de créer la réduction.
 */
export default async function handler(req, res) {
  if (preflight(req, res)) return;
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'Méthode non autorisée.');
    const id = customerFromToken(req);
    const reward = CLUB.rewards.find((r) => r.id === str(readBody(req).reward, { max: 20 }));
    if (!reward) throw new HttpError(400, 'Récompense inconnue.');

    const c = await loadCustomer(id);
    if (c.points < reward.points) throw new HttpError(400, 'Pas encore assez de points.');

    const code = newCode();
    credit(c, -reward.points, `Échange : ${reward.label}`, { c: code });
    await saveCustomer(c);

    try {
      await createDiscount(c.id, reward, code);
    } catch (error) {
      const fresh = await loadCustomer(id);
      credit(fresh, reward.points, `Remboursé : ${reward.label}`);
      fresh.total -= reward.points; // un remboursement ne fait pas monter de palier
      await saveCustomer(fresh);
      throw error;
    }

    return json(res, 200, { ...publicState(c), code, reward });
  } catch (error) {
    return fail(res, error);
  }
}
