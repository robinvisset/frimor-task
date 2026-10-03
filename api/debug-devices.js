// Route de diagnostic temporaire : liste les appareils enregistrés côté
// OneSignal, ET les dernières notifications envoyées/programmées avec leur
// nombre de destinataires réels. Sert à comprendre pourquoi une notification
// programmée n'arrive pas sur le téléphone. À supprimer une fois résolu.

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

    const rn = await fetch('https://onesignal.com/api/v1/notifications?app_id=' + ONESIGNAL_APP_ID + '&limit=8', {
      headers: { Authorization: 'Basic ' + ONESIGNAL_REST_API_KEY }
    });
    const ndata = await rn.json();
    const list = (ndata.notifications || []).slice(0, 8);
    const notifications = [];
    for (const n of list) {
      const rd = await fetch('https://onesignal.com/api/v1/notifications/' + n.id + '?app_id=' + ONESIGNAL_APP_ID, {
        headers: { Authorization: 'Basic ' + ONESIGNAL_REST_API_KEY }
      });
      const d = await rd.json().catch(function () { return {}; });
      notifications.push({
        id: n.id,
        content: (n.contents && (n.contents.fr || n.contents.en)) || null,
        send_after: n.send_after || null,
        queued_at: n.queued_at ? new Date(n.queued_at * 1000).toISOString() : null,
        completed_at: n.completed_at ? new Date(n.completed_at * 1000).toISOString() : null,
        canceled: n.canceled || false,
        successful: d.successful,
        failed: d.failed,
        errored: d.errored,
        remaining: d.remaining,
        converted: d.converted
      });
    }

    res.status(200).json({ total_devices: data.total_count, devices: devices, notifications: notifications });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
