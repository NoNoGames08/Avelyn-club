import { HttpError, fail, readBody, str } from './_lib/http.js';
import { CLUB } from './_lib/club-config.js';
import { preflight, customerFromToken, loadCustomer, saveCustomer, ensureJoined, credit, admin, safeTags, withRetry, birthdayTag, publicState, json } from './_lib/club.js';

/**
 * POST /api/action { type, date? } — actions uniques qui rapportent des points :
 * newsletter (inscrit réellement la cliente), instagram, tiktok (déclaratif,
 * comme partout), birthday (date AAAA-MM-JJ, une seule fois — corrigeable
 * 7 jours, sans nouveaux points). `gained` = points réellement crédités.
 */
export default async function handler(req, res) {
  if (preflight(req, res)) return;
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'Méthode non autorisée.');
    const id = customerFromToken(req);
    const body = readBody(req);
    const type = str(body.type, { max: 20 });
    const action = CLUB.actions[type];
    if (!action || type === 'join') throw new HttpError(400, 'Action inconnue.');

    let date = '';
    if (type === 'birthday') {
      date = str(body.date, { max: 10 });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new HttpError(400, 'Date invalide.');
      const year = Number(date.slice(0, 4));
      if (year < 1920 || year > new Date().getFullYear() - 13) throw new HttpError(400, 'Date invalide.');
    }

    let already = false;
    let tags = [];
    let gained = 0;
    const c = await withRetry(async () => {
      const fresh = await loadCustomer(id);
      const { extra, tags: repair, joined } = await ensureJoined(fresh);
      tags = repair;
      gained = joined ? CLUB.actions.join.points : 0;
      if (fresh.actions[type]) {
        // Anniversaire : une faute de frappe se corrige dans les 7 jours, sans nouveaux points.
        const recent = Date.now() - Date.parse(fresh.actions.birthday || 0) <= 7 * 864e5;
        if (type === 'birthday' && recent && date && date !== fresh.birthday) {
          fresh.birthday = date;
          extra.push({ ownerId: fresh.id, namespace: 'loyalty', key: 'birthday', type: 'date', value: date });
          tags.push(birthdayTag(date));
          fresh.history.unshift({ d: new Date().toISOString().slice(0, 10), p: 0, l: 'Date d’anniversaire corrigée' });
          await saveCustomer(fresh, { extra });
          return fresh;
        }
        already = true;
        if (extra.length || joined) await saveCustomer(fresh, { extra });
        return fresh;
      }
      if (type === 'newsletter' && !fresh.subscribed) {
        const data = await admin(
          `mutation($input: CustomerEmailMarketingConsentUpdateInput!) {
            customerEmailMarketingConsentUpdate(input: $input) { userErrors { field message } }
          }`,
          { input: { customerId: fresh.id, emailMarketingConsent: { marketingState: 'SUBSCRIBED', marketingOptInLevel: 'SINGLE_OPT_IN', consentUpdatedAt: new Date().toISOString() } } }
        );
        if (data.customerEmailMarketingConsentUpdate.userErrors.length) throw new HttpError(422, 'Inscription à la newsletter impossible pour le moment. Réessayez dans un instant.');
      }
      if (type === 'birthday') {
        fresh.birthday = date;
        extra.push({ ownerId: fresh.id, namespace: 'loyalty', key: 'birthday', type: 'date', value: date });
        tags.push(birthdayTag(date));
      }
      fresh.actions[type] = new Date().toISOString().slice(0, 10);
      credit(fresh, action.points, action.label);
      gained += action.points;
      await saveCustomer(fresh, { extra });
      return fresh;
    });
    await safeTags(c.id, tags);
    if (already) return json(res, 200, { ...publicState(c), already: true, gained });
    return json(res, 200, { ...publicState(c), gained });
  } catch (error) {
    return fail(res, error);
  }
}
