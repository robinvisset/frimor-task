// Fonction serveur Vercel, appelée une fois par jour par le cron défini
// dans vercel.json (et déclenchable à la main avec ?secret=..., voir le guide).
//
// Son travail : regarder les tâches dans Supabase, et pour chacune qui
// doit sonner aujourd'hui ou demain, demander à OneSignal d'envoyer une
// notification programmée 20 minutes avant l'heure de la tâche.
//
// Protégée par CRON_SECRET car accessible publiquement sur internet :
// sans ça, n'importe qui pourrait déclencher l'envoi de notifications.
// Pour une synchronisation manuelle sans secret, voir sync-notifications.js
// (appelée automatiquement par le bouton "Synchroniser" dans l'appli).

const { runScheduling } = require('./_lib');

const CRON_SECRET = process.env.CRON_SECRET; // optionnel mais recommandé

module.exports = async (req, res) => {
  try {
    if (CRON_SECRET) {
      const auth = req.headers['authorization'];
      const querySecret = req.query && req.query.secret;
      const ok = auth === 'Bearer ' + CRON_SECRET || querySecret === CRON_SECRET;
      if (!ok) { res.status(401).json({ error: 'unauthorized' }); return; }
    }

    const result = await runScheduling();
    res.status(result.error ? 500 : 200).json(result);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
