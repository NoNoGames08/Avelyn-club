import { HttpError, fail, readBody, str } from './_lib/http.js';
import { CLUB } from './_lib/club-config.js';
import { preflight, customerFromToken, loadCustomer, saveCustomer, ensureJoined, credit, admin, addTags, publicState, json } from './_lib/club.js';

/**
 * POST /api/action { type, date? } — actions uniques qui rapportent des points :
 * newsletter (inscrit réellement la cliente), instagram, tiktok (déclaratif,
 * comme partout), birthday (date AAAA-MM-JJ, une seule fois).
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

    const c = await loadCustomer(id);
    const { extra, tags } = ensureJoined(c);
    if (c.actions[type]) return json(res, 200, { ...publicState(c), already: true });

    if (type === 'newsletter' && !c.subscribed) {
      const data = await admin(
        `mutation($input: CustomerEmailMarketingConsentUpdateInput!) {
          customerEmailMarketingConsentUpdate(input: $input) { userErrors { field message } }
        }`,
        { input: { customerId: c.id, emailMarketingConsent: { marketingState: 'SUBSCRIBED', marketingOptInLevel: 'SINGLE_OPT_IN', consentUpdatedAt: new Date().toISOString() } } }
      );
      const errors = data.customerEmailMarketingConsentUpdate.userErrors;
      if (errors.length) throw new HttpError(422, `Newsletter : ${errors.map((e) => e.message).join(' / ')}`);
    }

    if (type === 'birthday') {
      const date = str(body.date, { max: 10 });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new HttpError(400, 'Date invalide.');
      const year = Number(date.slice(0, 4));
      if (year < 1920 || year > new Date().getFullYear() - 13) throw new HttpError(400, 'Date invalide.');
      c.birthday = date;
      extra.push({ ownerId: c.id, namespace: 'loyalty', key: 'birthday', type: 'date', value: date });
      tags.push(`bday${date.slice(5, 7)}${date.slice(8, 10)}`);
    }

    c.actions[type] = new Date().toISOString().slice(0, 10);
    credit(c, action.points, action.label);
    await saveCustomer(c, { extra });
    if (tags.length) await addTags(c.id, tags);
    return json(res, 200, publicState(c));
  } catch (error) {
    return fail(res, error);
  }
}
