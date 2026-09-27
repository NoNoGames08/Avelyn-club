# avelyn-club

Serveur du programme de fidélité **Avelyn Club** (Avelyn Monaco) — Vercel, zéro dépendance.
Séparé du projet `avelyn-gifting` (seeding influenceuses) le 27/09/2026.

| Route | Appelée par | Rôle |
|---|---|---|
| `GET /api/me` | extension espace client (jeton de session) | état du club, inscription (+200) et code de parrainage à la 1re visite |
| `POST /api/action` | extension | newsletter, Instagram, TikTok, anniversaire — une fois chacune |
| `POST /api/redeem` | extension | échange de points → code personnel `CLUB-XXXXXX` |
| `POST /api/order` | webhook Shopify `orders/paid` (signé) | points d'achat, parrainage, palier |
| `GET /api/birthdays` | tâche Vercel, chaque jour 6 h UTC | cadeau d'anniversaire annuel |

Barème : `api/_lib/club-config.js` (fait foi — garder la page du thème alignée).

## Variables Vercel
- `CLUB_CLIENT_ID` = `55351a2d3e9eabf68b679fcf21092073` (app Shopify avelyn-fidelite)
- `CLUB_CLIENT_SECRET` = secret client de l'app (Dev Dashboard → avelyn-fidelite)
- `CRON_SECRET` (facultatif), `CLUB_SHOP_DOMAIN` (facultatif, défaut `e2ngf7-wj.myshopify.com`)

Domaine : `club.avelynmonaco.com` (CNAME `club` → `cname.vercel-dns.com` chez IONOS).
Doc complète : `~/Documents/Avelyn Monaco/fidelite/README.md`.
