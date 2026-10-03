// Route de diagnostic temporaire : liste les appareils enregistrés côté
// OneSignal pour voir s'ils sont bien abonnés aux notifications push.
// Utile pour comprendre pourquoi une notification programmée n'arrive pas.
// À supprimer une fois le problème de livraison résolu.

const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;

module.exports = async (req, res) => {
  try {
    const r = await fetch('https://onesignal.com/api/v1/players?app_id=' + ONESIGNAL_APP_ID + '&limit=20', {
      headers: { Authorization: 'Basic ' + ONESIGNAL_REST_API_KEY }
    });
    const data = await r.json();
    const devices = (data.players || []).map(function (p) {
      return {
        id: p.id,
        device_type: p.device_type,
        notification_types: p.notification_types,
        last_active: p.last_active ? new Date(p.last_active * 1000).toISOString() : null,
        invalid: p.invalid_identifier,
        created_at: p.created_at ? new Date(p.created_at * 1000).toISOString() : null
      };
    });
    res.status(200).json({ total: data.total_count, devices: devices });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
