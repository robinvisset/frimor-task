// Route appelée par le bouton "Synchroniser les notifications" dans
// l'appli. Fait exactement la même chose que schedule-notifications.js,
// mais sans secret à fournir, pour pouvoir être déclenchée directement
// depuis le téléphone juste après avoir ajouté une tâche — sans attendre
// le passage automatique du soir.
//
// Pas de risque à la laisser ouverte : chaque notification n'est
// programmée qu'une seule fois (table scheduled_notifications), donc
// appeler cette route plusieurs fois ne renvoie jamais deux fois la
// même notification.

const { runScheduling } = require('./_lib');

module.exports = async (req, res) => {
  try {
    const result = await runScheduling();
    res.status(result.error ? 500 : 200).json(result);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
