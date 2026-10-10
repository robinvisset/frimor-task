// Route appelée automatiquement par l'appli dès qu'une tâche est supprimée.
// Annule tout de suite les rappels déjà programmés chez OneSignal pour cette
// tâche (au lieu de les laisser sonner quand même le lendemain).
//
// Pas besoin de secret ici : ça ne fait qu'annuler des notifications liées
// à une tâche qui, de toute façon, vient d'être supprimée.

const { cancelNotificationsForTask } = require('./_lib');

module.exports = async (req, res) => {
  try {
    const taskId = req.query && req.query.task_id;
    if (!taskId) { res.status(400).json({ error: 'missing_params' }); return; }
    const result = await cancelNotificationsForTask(taskId);
    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
