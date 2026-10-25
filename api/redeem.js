import { HttpError, fail, readBody, str } from './_lib/http.js';
import { CLUB } from './_lib/club-config.js';
import { preflight, customerFromToken, loadCustomer, saveCustomer, credit, newCode, createDiscount, safeTags, admin, withRetry, publicState, json } from './_lib/club.js';

/**
 * POST /api/redeem { reward } — échange des points.
 *
 * - code (livraison, montants) : les points sont retirés AVANT la création du
 *   code (compareDigest empêche un double échange). Si Shopify refuse le code
 *   ET qu'il n'existe pas, les points sont rendus (avec relance sur conflit).
 * - experience (grandes récompenses) : pas de code — points retirés, demande
 *   gardée dans actions.requests, tags « club-demande » et
 *   « club-demande-<id> » pour que Noé la contacte (réparés s'ils manquent).
 * - ticket (tirage) : un ticket de plus (loyalty.tickets), tag « club-tirage ».
 */
export default async function handler(req, res) {
  if (preflight(req, res)) return;
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'Méthode non autorisée.');
    const id = customerFromToken(req);
    const reward = CLUB.rewards.find((r) => r.id === str(readBody(req).reward, { max: 20 }));
    if (!reward) throw new HttpError(400, 'Récompense inconnue.');
    const today = new Date().toISOString().slice(0, 10);

    if (reward.kind === 'ticket' || reward.kind === 'experience') {
      const c = await withRetry(async () => {
        const fresh = await loadCustomer(id);
        if (fresh.points < reward.points) throw new HttpError(400, 'Pas encore assez de points.');
        if (reward.kind === 'ticket') {
          fresh.tickets += 1;
          credit(fresh, -reward.points, `Ticket : ${reward.label}`);
        } else {
          fresh.actions.requests = fresh.actions.requests || [];
          fresh.actions.requests.push({ id: reward.id, d: today });
          credit(fresh, -reward.points, `Demande : ${reward.label}`);
        }
        await saveCustomer(fresh);
        return fresh;
      });
      await safeTags(c.id, reward.kind === 'ticket' ? ['club-tirage'] : ['club-demande', `club-demande-${reward.id}`]);
      return json(res, 200, reward.kind === 'ticket'
        ? { ...publicState(c), ticket: true, reward }
        : { ...publicState(c), request: true, reward });
    }

    const code = newCode();
    const c = await withRetry(async () => {
      const fresh = await loadCustomer(id);
      if (fresh.points < reward.points) throw new HttpError(400, 'Pas encore assez de points.');
      credit(fresh, -reward.points, `Échange : ${reward.label}`);
      fresh.actions.codes = [{ code, label: reward.label, date: today }, ...(fresh.actions.codes || [])].slice(0, 30);
      await saveCustomer(fresh);
      return fresh;
    });

    try {
      await createDiscount(c.id, reward, code);
    } catch (error) {
      // Délai dépassé alors que Shopify a bien créé le code : on le garde.
      const exists = await admin(`query($code: String!) { codeDiscountNodeByCode(code: $code) { id } }`, { code }).catch(() => null);
      if (exists?.codeDiscountNodeByCode?.id) return json(res, 200, { ...publicState(c), code, reward });
      await withRetry(async () => {
        const fresh = await loadCustomer(id);
        fresh.points += reward.points; // un remboursement ne fait pas monter de palier
        fresh.history.unshift({ d: today, p: reward.points, l: `Rendu : ${reward.label} (code non créé)` });
        fresh.actions.codes = (fresh.actions.codes || []).filter((x) => x.code !== code);
        await saveCustomer(fresh);
      });
      throw error;
    }

    return json(res, 200, { ...publicState(c), code, reward });
  } catch (error) {
    return fail(res, error);
  }
}
