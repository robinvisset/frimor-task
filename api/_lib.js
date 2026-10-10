// Code partagé entre les deux routes de programmation des notifications
// (schedule-notifications.js, utilisée par le cron automatique du soir et
// par le lien secret, et sync-notifications.js, appelée par le bouton
// "Synchroniser les notifications" dans l'appli).
//
// Fichier préfixé par "_" : Vercel ne le traite pas comme une route, il ne
// sert qu'en tant que module importé par les deux autres fichiers.
//
// Depuis l'ajout du multi-employés : chaque tâche appartient soit à un
// employé (tâche personnelle, owner_employee_id), soit est "obligatoire"
// (is_mandatory) et assignée à une liste d'employés via task_assignees.
// Chaque notification est désormais envoyée UNIQUEMENT aux employés
// concernés par la tâche, en ciblant directement leurs player_ids
// OneSignal (et plus jamais tous les appareils abonnés).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;
const REMINDER_LEAD_MIN = 20;
// Délai après l'heure prévue d'une tâche OBLIGATOIRE avant d'alerter le
// patron si elle n'est toujours pas faite (voir plus bas, "alerte patron").
const OVERDUE_ALERT_DELAY_MIN = 45;
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

async function supabaseDelete(path) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method: 'DELETE',
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
  });
  if (!res.ok) throw new Error('Supabase DELETE ' + path + ' -> ' + res.status + ' ' + await res.text());
}

// Envoie (ou programme) une notification à un ou plusieurs appareils précis,
// identifiés par leurs OneSignal player_ids — jamais à "tous les abonnés".
async function oneSignalSchedule(title, body, sendAfterUtc, playerIds) {
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
      include_player_ids: playerIds,
      send_after: sendAfterUtc.toUTCString()
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('OneSignal -> ' + res.status + ' ' + JSON.stringify(data));
  return data;
}

// Annule une notification OneSignal programmée (pas encore envoyée). Si elle
// a déjà été envoyée, OneSignal renvoie une erreur qu'on ignore simplement.
async function oneSignalCancel(notificationId) {
  try {
    await fetch('https://onesignal.com/api/v1/notifications/' + notificationId + '?app_id=' + ONESIGNAL_APP_ID, {
      method: 'DELETE',
      headers: { Authorization: 'Basic ' + ONESIGNAL_REST_API_KEY }
    });
  } catch (e) {}
}

// Pour une tâche donnée, renvoie la liste des id employés qui doivent être
// notifiés : les employés assignés pour une tâche obligatoire, ou le seul
// propriétaire pour une tâche personnelle.
function recipientsForTask(task, assigneesByTask) {
  if (task.is_mandatory) {
    return assigneesByTask[task.id] || [];
  }
  return task.owner_employee_id ? [task.owner_employee_id] : [];
}

// Regarde les tâches dans Supabase, et pour chacune qui doit sonner
// aujourd'hui ou demain, demande à OneSignal d'envoyer — à chaque employé
// concerné, et uniquement à lui — une notification programmée 20 minutes
// avant l'heure de la tâche. Idempotent : une paire (tâche, employé, date)
// déjà programmée n'est jamais reprogrammée deux fois.
async function runScheduling() {
  if (!SUPABASE_URL || !SUPABASE_KEY || !ONESIGNAL_APP_ID || !ONESIGNAL_REST_API_KEY) {
    return { error: 'missing_env', detail: 'Vérifie les variables d\'environnement Vercel.' };
  }

  const [employees, tasks, assigneeRows] = await Promise.all([
    supabaseGet('employees?select=id,player_ids,is_admin'),
    supabaseGet('tasks?select=id,title,time,recurrence_type,recurrence_days,owner_employee_id,is_mandatory'),
    supabaseGet('task_assignees?select=task_id,employee_id')
  ]);

  const employeeById = {};
  for (const e of employees) employeeById[e.id] = e;

  // Appareils des patrons (is_admin), pour les alertes "tâche obligatoire
  // pas encore faite" — jamais ceux des employés.
  const adminPlayerIds = Array.from(new Set(
    employees.filter(e => e.is_admin).flatMap(e => e.player_ids || [])
  ));

  const assigneesByTask = {};
  for (const row of assigneeRows) {
    if (!assigneesByTask[row.task_id]) assigneesByTask[row.task_id] = [];
    assigneesByTask[row.task_id].push(row.employee_id);
  }

  const now = new Date();
  const todayYMD = parisTodayYMD(now);
  const tomorrowYMD = addDaysYMD(todayYMD, 1);
  const dsToday = ymdToDs(todayYMD);
  const dsTomorrow = ymdToDs(tomorrowYMD);

  // Une seule requête pour connaître tout ce qui est déjà programmé sur ces
  // deux jours, plutôt qu'une requête par (tâche, employé) — évite de
  // multiplier les appels Supabase quand il y a plusieurs employés.
  const [already, alreadyOverdue] = await Promise.all([
    supabaseGet('scheduled_notifications?select=id&date=in.(' + dsToday + ',' + dsTomorrow + ')'),
    supabaseGet('overdue_alerts?select=id&date=in.(' + dsToday + ',' + dsTomorrow + ')')
  ]);
  const scheduledSet = new Set(already.map(r => r.id));
  const overdueSet = new Set(alreadyOverdue.map(r => r.id));

  let scheduled = 0, skipped = 0;
  const errors = [];
  const details = []; // debug temporaire : infos OneSignal par notification créée

  for (const ymd of [todayYMD, tomorrowYMD]) {
    const ds = ymdToDs(ymd);
    const weekday = weekdayOf(ymd);
    for (const task of tasks) {
      if (!isScheduled(task, weekday)) continue;
      const [hh, mm] = task.time.split(':').map(Number);
      const taskUtc = zonedWallTimeToUtc(ymd.y, ymd.m, ymd.d, hh, mm, TIME_ZONE);
      const sendAt = new Date(taskUtc.getTime() - REMINDER_LEAD_MIN * 60000);
      const recipients = recipientsForTask(task, assigneesByTask);

      if (sendAt.getTime() > now.getTime() + 60000) { // pas encore passé
        for (const employeeId of recipients) {
          const employee = employeeById[employeeId];
          const playerIds = (employee && employee.player_ids) || [];
          if (!playerIds.length) { skipped++; continue; } // pas encore d'appareil connu pour cet employé

          const id = ds + '_' + task.id + '_' + employeeId;
          if (scheduledSet.has(id)) { skipped++; continue; }

          try {
            const osResult = await oneSignalSchedule('Frimor Task', task.title + ' — dans ' + REMINDER_LEAD_MIN + ' min', sendAt, playerIds);
            await supabaseInsert('scheduled_notifications', { id, task_id: task.id, date: ds, employee_id: employeeId, onesignal_id: osResult.id });
            scheduledSet.add(id);
            scheduled++;
            details.push({ task: task.title, employeeId, date: ds, sendAt: sendAt.toISOString(), oneSignalId: osResult.id, recipients: osResult.recipients, errorsFromOS: osResult.errors });
          } catch (e) {
            errors.push({ task: task.title, employeeId, date: ds, error: String(e.message || e) });
          }
        }
      } else {
        skipped++;
      }

      // Alerte au patron si une tâche OBLIGATOIRE n'est toujours pas faite
      // OVERDUE_ALERT_DELAY_MIN minutes après son heure prévue. Une seule
      // alerte par (tâche, jour) — annulée automatiquement si tout le monde
      // a fini avant l'envoi (voir cancelOverdueAlertIfComplete, appelée par
      // l'appli dès qu'un employé coche une tâche obligatoire).
      if (task.is_mandatory && recipients.length && adminPlayerIds.length) {
        const overdueId = ds + '_' + task.id;
        const overdueSendAt = new Date(taskUtc.getTime() + OVERDUE_ALERT_DELAY_MIN * 60000);
        if (!overdueSet.has(overdueId) && overdueSendAt.getTime() > now.getTime() + 60000) {
          try {
            const osResult = await oneSignalSchedule('Frimor Task', '⚠️ ' + task.title + ' (obligatoire) — toujours pas faite ?', overdueSendAt, adminPlayerIds);
            await supabaseInsert('overdue_alerts', { id: overdueId, task_id: task.id, date: ds, onesignal_id: osResult.id });
            overdueSet.add(overdueId);
            scheduled++;
          } catch (e) {
            errors.push({ task: task.title, overdue: true, date: ds, error: String(e.message || e) });
          }
        }
      }
    }
  }

  return { ok: true, scheduled, skipped, errors, details, ranAt: now.toISOString() };
}

// Appelée par l'appli dès qu'un employé coche une tâche obligatoire comme
// faite. Si TOUS les employés concernés par cette tâche l'ont faite
// aujourd'hui, annule l'alerte "pas encore faite" programmée pour le patron
// (si elle existe encore) pour éviter une fausse alerte.
async function cancelOverdueAlertIfComplete(taskId, ds) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return { ok: false, error: 'missing_env' };

  const alertRows = await supabaseGet('overdue_alerts?select=id,onesignal_id&id=eq.' + encodeURIComponent(ds + '_' + taskId));
  if (!alertRows.length) return { ok: true, skipped: true }; // rien de programmé, rien à faire

  const assigneeRows = await supabaseGet('task_assignees?select=employee_id&task_id=eq.' + encodeURIComponent(taskId));
  const assigneeIds = assigneeRows.map(r => r.employee_id);
  if (!assigneeIds.length) return { ok: true, skipped: true };

  const logRows = await supabaseGet('logs?select=employee_id,done&date=eq.' + encodeURIComponent(ds) + '&task_id=eq.' + encodeURIComponent(taskId));
  const doneByEmployee = {};
  logRows.forEach(r => { doneByEmployee[r.employee_id] = !!r.done; });
  const allDone = assigneeIds.every(id => doneByEmployee[id]);
  if (!allDone) return { ok: true, allDone: false };

  const alert = alertRows[0];
  if (alert.onesignal_id) await oneSignalCancel(alert.onesignal_id);
  await supabaseDelete('overdue_alerts?id=eq.' + encodeURIComponent(alert.id));
  return { ok: true, cancelled: true };
}

// Appelée par l'appli dès qu'une tâche est supprimée (par un employé pour
// ses tâches perso, ou par le patron pour une tâche obligatoire). Annule
// immédiatement tout rappel déjà programmé chez OneSignal pour cette tâche
// (aujourd'hui et demain), au lieu d'attendre qu'il parte "pour rien".
async function cancelNotificationsForTask(taskId) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return { ok: false, error: 'missing_env' };

  const [scheduledRows, overdueRows] = await Promise.all([
    supabaseGet('scheduled_notifications?select=id,onesignal_id&task_id=eq.' + encodeURIComponent(taskId)),
    supabaseGet('overdue_alerts?select=id,onesignal_id&task_id=eq.' + encodeURIComponent(taskId))
  ]);

  let cancelled = 0;
  for (const row of scheduledRows) {
    if (row.onesignal_id) { await oneSignalCancel(row.onesignal_id); cancelled++; }
    await supabaseDelete('scheduled_notifications?id=eq.' + encodeURIComponent(row.id));
  }
  for (const row of overdueRows) {
    if (row.onesignal_id) { await oneSignalCancel(row.onesignal_id); cancelled++; }
    await supabaseDelete('overdue_alerts?id=eq.' + encodeURIComponent(row.id));
  }

  return { ok: true, cancelled };
}

module.exports = { runScheduling, cancelOverdueAlertIfComplete, cancelNotificationsForTask };
