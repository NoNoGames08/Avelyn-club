import { HttpError, fail } from './_lib/http.js';
import { CLUB } from './_lib/club-config.js';
import { admin, loadCustomer, saveCustomer, credit, json } from './_lib/club.js';

/**
 * GET /api/birthdays — tâche planifiée Vercel (vercel.json → crons),
 * chaque matin : crédite le cadeau d'anniversaire aux clientes taguées
 * bday<MMJJ> du jour, une fois par an.
 */
export default async function handler(req, res) {
  try {
    const auth = req.headers.authorization || '';
    // CRON_SECRET facultatif : sans lui la route reste sans danger (une fois par an et par cliente).
    if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) throw new HttpError(401, 'Non autorisé.');

    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    const tag = `bday${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const year = String(now.getFullYear());
    let cursor = null;
    let credited = 0;
    for (let page = 0; page < 20; page += 1) {
      const data = await admin(
        `query($q: String!, $after: String) { customers(first: 50, after: $after, query: $q) { pageInfo { hasNextPage endCursor } nodes { id } } }`,
        { q: `tag:${tag}`, after: cursor }
      );
      for (const { id } of data.customers.nodes) {
        const c = await loadCustomer(id);
        if (c.actions.birthday_gift === year) continue;
        c.actions.birthday_gift = year;
        credit(c, CLUB.birthdayGift, 'Joyeux anniversaire');
        await saveCustomer(c);
        credited += 1;
      }
      if (!data.customers.pageInfo.hasNextPage) break;
      cursor = data.customers.pageInfo.endCursor;
    }
    return json(res, 200, { tag, credited });
  } catch (error) {
    return fail(res, error);
  }
}
