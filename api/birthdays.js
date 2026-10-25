import { HttpError, fail } from './_lib/http.js';
import { CLUB } from './_lib/club-config.js';
import { admin, loadCustomer, saveCustomer, credit, withRetry, json } from './_lib/club.js';

/**
 * GET /api/birthdays — tâche planifiée Vercel (vercel.json → crons), chaque
 * matin : crédite le cadeau d'anniversaire aux clientes taguées bday<MMJJ>,
 * une fois par an. Repasse aussi sur les 3 jours précédents (un matin raté
 * est rattrapé, une cliente déjà fêtée n'est pas recréditée) ; les nées un
 * 29 février sont fêtées le 28 les années non bissextiles. Une erreur sur une
 * cliente n'empêche jamais les suivantes.
 */
export default async function handler(req, res) {
  try {
    const auth = req.headers.authorization || '';
    // CRON_SECRET facultatif : sans lui la route reste sans danger (une fois par an et par cliente).
    if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) throw new HttpError(401, 'Non autorisé.');

    const paris = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    const year = String(paris.getFullYear());
    const leap = new Date(paris.getFullYear(), 1, 29).getMonth() === 1;
    const tags = new Set();
    for (let back = 0; back <= 3; back += 1) {
      const d = new Date(paris);
      d.setDate(d.getDate() - back);
      if (String(d.getFullYear()) !== year) continue;
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      tags.add(`bday${mm}${dd}`);
      if (!leap && mm === '02' && dd === '28') tags.add('bday0229');
    }

    let credited = 0;
    const failed = [];
    for (const tag of tags) {
      let cursor = null;
      for (let page = 0; page < 20; page += 1) {
        const data = await admin(
          `query($q: String!, $after: String) { customers(first: 50, after: $after, query: $q) { pageInfo { hasNextPage endCursor } nodes { id } } }`,
          { q: `tag:${tag}`, after: cursor }
        );
        for (const { id } of data.customers.nodes) {
          try {
            const done = await withRetry(async () => {
              const c = await loadCustomer(id);
              if (c.actions.birthday_gift === year) return false;
              c.actions.birthday_gift = year;
              credit(c, CLUB.birthdayGift, 'Joyeux anniversaire');
              await saveCustomer(c);
              return true;
            });
            if (done) credited += 1;
          } catch (error) {
            console.error('anniversaire', id, error.message);
            failed.push(id);
          }
        }
        if (!data.customers.pageInfo.hasNextPage) break;
        cursor = data.customers.pageInfo.endCursor;
      }
    }
    return json(res, 200, { tags: [...tags], credited, failed });
  } catch (error) {
    return fail(res, error);
  }
}
