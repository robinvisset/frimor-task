# Frimor Task — version web autonome

Appli de tâches répétitives pour Frimor, avec vraies notifications
push (écran verrouillé compris). Le guide complet de mise en ligne
(pas à pas, pensé pour quelqu'un qui ne code pas) a été fourni à part.

## En bref

- `index.html`, `style.css`, `app.js` — l'appli elle-même.
- `config.js` — à remplir avec tes clés Supabase et OneSignal (3 lignes).
- `manifest.json`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png`,
  `OneSignalSDKWorker.js` — nécessaires pour l'installer comme une vraie
  appli et recevoir des notifications.
- `supabase-schema.sql` — à exécuter une fois dans Supabase pour créer
  les tables.
- `api/schedule-notifications.js` + `vercel.json` — la partie serveur
  qui programme chaque jour les notifications du lendemain.

## Services utilisés (tous gratuits à cette échelle)

- **Supabase** — stocke les tâches et le suivi.
- **OneSignal** — envoie les notifications.
- **GitHub** — héberge le code.
- **Vercel** — met le site en ligne et exécute la tâche quotidienne de
  programmation des notifications.

Aucun de ces comptes ne demande de carte bancaire pour cet usage.
