// Fonction serveur Vercel, appelée une fois par jour par le cron défini
// dans vercel.json (et déclenchable à la main, voir le guide).
//
// Son travail : regarder les tâches dans Supabase, et pour chacune qui
// doit sonner aujourd'hui ou demain, demander à OneSignal d'envoyer une
// notification programmée 20 minutes avant l'heure de la tâche.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET; // optionnel mais recommandé
const REMINDER_LEAD_MIN = 20;
const TIME_ZONE = 'Europe/Paris';

function timeZoneOffsetMinutes(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map(p => [p.type, p.value]));
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return (asUTC - date.getTime()) / 60000;
}

function zonedWallTimeToUtc(y, m, d, hh, mm, timeZone) {
  let guess = new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
  const offsetMin = timeZoneOffsetMinutes(guess, timeZone);
  return new Date(guess.getTime() - offsetMin * 60000);
}

function parisTodayYMD(now) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = Object.fromEntries(dtf.formatToParts(now).map(p => [p.type, p.value]));
  return { y: +parts.year, m: +parts.month, d: +parts.day };
}

function addDaysYMD(ymd, delta) {
  const dt = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function ymdToDs(ymd) {
  return ymd.y + '-' + String(ymd.m).padStart(2, '0') + '-' + String(ymd.d).padStart(2, '0');
}

function weekdayOf(ymd) {
  return new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d)).getUTCDay();
}

function isScheduled(task, weekday) {
  if (task.recurrence_type !== 'days') return true;
  return (task.recurrence_days || []).includes(weekday);
}

async function supabaseGet(path) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
  });
  if (!res.ok) throw new Error('Supabase GET ' + path + ' -> ' + res.status + ' ' + await res.text());
  return res.json();
}

async function supabaseInsert(table, row) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + table, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'resolution=ignore-duplicates,return=minimal'
    },
    body: JSON.stringify(row)
  });
  // 201 = created, 409/ignore-duplicates = already scheduled: both fine
  if (!res.ok && res.status !== 409) {
    throw new Error('Supabase INSERT ' + table + ' -> ' + res.status + ' ' + await res.text());
  }
}

async function oneSignalSchedule(title, body, sendAfterUtc) {
  const res = await fetch('https://onesignal.com/api/v1/notifications', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + ONESIGNAL_REST_API_KEY,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({
      app_id: ONESIGNAL_APP_ID,
      headings: { en: title, fr: title },
      contents: { en: body, fr: body },
      included_segments: ['Subscribed Users'],
      send_after: sendAfterUtc.toUTCString()
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('OneSignal -> ' + res.status + ' ' + JSON.stringify(data));
  return data;
}

module.exports = async (req, res) => {
  try {
    if (CRON_SECRET) {
      const auth = req.headers['authorization'];
      const querySecret = req.query && req.query.secret;
      const ok = auth === 'Bearer ' + CRON_SECRET || querySecret === CRON_SECRET;
      if (!ok) { res.status(401).json({ error: 'unauthorized' }); return; }
    }
    if (!SUPABASE_URL || !SUPABASE_KEY || !ONESIGNAL_APP_ID || !ONESIGNAL_REST_API_KEY) {
      res.status(500).json({ error: 'missing_env', detail: 'Vérifie les variables d\'environnement Vercel.' });
      return;
    }

    const tasks = await supabaseGet('tasks?select=id,title,time,recurrence_type,recurrence_days');
    const now = new Date();
    const todayYMD = parisTodayYMD(now);
    const tomorrowYMD = addDaysYMD(todayYMD, 1);

    let scheduled = 0, skipped = 0;
    const errors = [];

    for (const ymd of [todayYMD, tomorrowYMD]) {
      const ds = ymdToDs(ymd);
      const weekday = weekdayOf(ymd);
      for (const task of tasks) {
        if (!isScheduled(task, weekday)) continue;
        const [hh, mm] = task.time.split(':').map(Number);
        const taskUtc = zonedWallTimeToUtc(ymd.y, ymd.m, ymd.d, hh, mm, TIME_ZONE);
        const sendAt = new Date(taskUtc.getTime() - REMINDER_LEAD_MIN * 60000);
        if (sendAt.getTime() <= now.getTime() + 60000) { skipped++; continue; } // déjà passé

        const id = ds + '_' + task.id;
        try {
          // marque la tâche comme programmée AVANT d'appeler OneSignal : si cette
          // ligne existe déjà, la contrainte "primary key" la rejette et on saute
          // sans jamais notifier deux fois, même si la fonction tourne deux fois.
          const already = await supabaseGet('scheduled_notifications?select=id&id=eq.' + encodeURIComponent(id));
          if (already.length > 0) { skipped++; continue; }

          await oneSignalSchedule('Frimor Task', task.title + ' — dans ' + REMINDER_LEAD_MIN + ' min', sendAt);
          await supabaseInsert('scheduled_notifications', { id, task_id: task.id, date: ds });
          scheduled++;
        } catch (e) {
          errors.push({ task: task.title, date: ds, error: String(e.message || e) });
        }
      }
    }

    res.status(200).json({ ok: true, scheduled, skipped, errors, ranAt: now.toISOString() });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
