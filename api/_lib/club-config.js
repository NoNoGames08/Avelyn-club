/**
 * Avelyn Club — le barème, à un seul endroit.
 *
 * Tout ce qui se gagne, s'échange et se débloque est ici. L'extension de
 * l'espace client et la page du thème lisent ce barème via /api/me :
 * changer une valeur ici la change partout (sauf les textes de la page du
 * thème, réglés dans l'éditeur).
 *
 * La carte à tampons (3 commandes = 1 pièce offerte) est aussi tenue ici
 * (avant le 27/09 : workflow Flow, désactivé depuis).
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

  /**
   * Crédités à la marraine quand la première commande de la filleule
   * (au moins `stamps.minSubtotal` €) est expédiée ; repris si cette commande
   * est remboursée sous ce seuil. Coût réel ≈ 8 € s'ils sont échangés, pour
   * une nouvelle cliente qui coûterait ≈ 30 € en pub.
   */
  referralPoints: 2000,

  rewards: [
    { id: 'shipping', points: 1000, label: 'Livraison offerte', kind: 'shipping' },
    { id: 'eur5', points: 1500, label: '5 € offerts', kind: 'amount', amount: '5.00' },
    { id: 'eur10', points: 3000, label: '10 € offerts', kind: 'amount', amount: '10.00' },
    { id: 'eur25', points: 6000, label: '25 € offerts', kind: 'amount', amount: '25.00' },

    // « Pour les plus mordues » — de vraies pièces, sur demande : les points
    // sont retirés, la cliente taguée « club-demande », Noé la contacte.
    // Règle anti-rouge : coût réel × 250 points au minimum (≤ 4 % de ce que
    // la cliente a dépensé pour les gagner, à 10 pts/€). `cost` = estimation
    // interne, jamais affichée.
    { id: 'brode', points: 8000, cost: 17, label: 'Une casquette brodée à votre prénom', kind: 'experience' },
    { id: 'annee', points: 25000, cost: 90, label: 'Un an de nouveautés offertes', kind: 'experience' },
    { id: 'carre', points: 40000, cost: 150, label: 'Un carré dessiné rien que pour vous', kind: 'experience' },
    { id: 'prenom', points: 50000, cost: 100, label: 'Votre prénom sur une pièce de la prochaine collection', kind: 'experience' },

    // Le tirage : un ticket par échange, autant de tickets qu'on veut. Un
    // seul lot par an (coût plafonné quel que soit le nombre de tickets).
    { id: 'grandprix', points: 1000, label: 'Le Grand Prix de Monaco, un week-end hors du temps', kind: 'ticket' }
  ],

  /** Paliers sur les points gagnés depuis l’inscription (un échange ne fait jamais redescendre ; un remboursement reprend les points de la commande). */
  tiers: [
    { id: 'plage', name: 'La Plage', min: 0 },
    { id: 'terrasse', name: 'La Terrasse', min: 3000 },
    { id: 'villa', name: 'La Villa', min: 8000 }
  ],

  /**
   * Carte à tampons : un tampon par commande EXPÉDIÉE en entier (jamais à la
   * simple commande — pas de tampon à retirer après une annulation).
   * Les commandes à 0 € (gifting, pièce offerte seule) ne comptent pas.
   */
  stamps: {
    goal: 3,
    /** Sous-total minimum (€, après remises) pour qu'une commande pose un tampon. */
    minSubtotal: 40,
    /** Remise plafonnée sur la collection « Cadeaux fidélité » : une pièce offerte, jamais plus. */
    giftCollectionId: 'gid://shopify/Collection/710939246934',
    giftAmount: '75.00',
    giftLabel: 'Pièce offerte — carte à tampons'
  },

  /** Nombre de mouvements gardés dans l'historique affiché. */
  historySize: 80
};

export function tierFor(total) {
  let current = CLUB.tiers[0];
  for (const tier of CLUB.tiers) if (total >= tier.min) current = tier;
  const next = CLUB.tiers.find((t) => t.min > total) || null;
  return { current, next };
}
