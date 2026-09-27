/**
 * Avelyn Club — le barème, à un seul endroit.
 *
 * Tout ce qui se gagne, s'échange et se débloque est ici. L'extension de
 * l'espace client et la page du thème lisent ce barème via /api/me :
 * changer une valeur ici la change partout (sauf les textes de la page du
 * thème, réglés dans l'éditeur).
 *
 * La carte à tampons (3 commandes = 1 pièce offerte) est un système à part,
 * tenu par le workflow Flow « Fidélité — tampons et pièce offerte ».
 */
export const CLUB = {
  name: 'Avelyn Club',
  storeUrl: 'https://avelynmonaco.com',

  /** Points par euro de sous-total payé (après remises, hors livraison). */
  pointsPerEuro: 10,

  /** Actions uniques. `url` : lien ouvert avant de créditer (réseaux). */
  actions: {
    join: { points: 200, label: 'Rejoindre le club' },
    newsletter: { points: 300, label: 'Recevoir la newsletter' },
    instagram: { points: 100, label: 'Suivre Avelyn sur Instagram', url: 'https://www.instagram.com/avelynmonaco/' },
    tiktok: { points: 100, label: 'Suivre Avelyn sur TikTok', url: 'https://www.tiktok.com/@avelynmonaco' },
    birthday: { points: 100, label: 'Indiquer sa date d’anniversaire' }
  },

  /** Crédités chaque année le jour de l'anniversaire (tâche planifiée). */
  birthdayGift: 500,

  /** Crédités à la marraine quand la filleule passe sa première commande. */
  referralPoints: 1000,

  rewards: [
    { id: 'shipping', points: 1000, label: 'Livraison offerte', kind: 'shipping' },
    { id: 'eur5', points: 1500, label: '5 € offerts', kind: 'amount', amount: '5.00' },
    { id: 'eur10', points: 3000, label: '10 € offerts', kind: 'amount', amount: '10.00' },
    { id: 'eur25', points: 6000, label: '25 € offerts', kind: 'amount', amount: '25.00' }
  ],

  /** Paliers sur les points gagnés depuis l'inscription (jamais diminués par un échange). */
  tiers: [
    { id: 'plage', name: 'La Plage', min: 0 },
    { id: 'terrasse', name: 'La Terrasse', min: 3000 },
    { id: 'villa', name: 'La Villa', min: 8000 }
  ],

  /** Nombre de mouvements gardés dans l'historique affiché. */
  historySize: 30
};

export function tierFor(total) {
  let current = CLUB.tiers[0];
  for (const tier of CLUB.tiers) if (total >= tier.min) current = tier;
  const next = CLUB.tiers.find((t) => t.min > total) || null;
  return { current, next };
}
