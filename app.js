(function(){
  "use strict";

  var CFG = window.FRIMOR_CONFIG || {};
  var CONFIGURED = CFG.SUPABASE_URL && CFG.SUPABASE_URL.indexOf('xxxx') === -1
                 && CFG.SUPABASE_ANON_KEY && CFG.SUPABASE_ANON_KEY.indexOf('colle-ici') === -1;
  var ONESIGNAL_CONFIGURED = CFG.ONESIGNAL_APP_ID && CFG.ONESIGNAL_APP_ID.indexOf('colle-ici') === -1;

  var sb = null;
  if (CONFIGURED && window.supabase){
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  }

  var tasks = {};   // id -> {id,title,time,createdAt,example,recurrence:{type,days}}
  var logs = {};    // "date_taskId" -> {date,taskId,done}
  var dueSoon = new Set();
  var overdue = new Set();
  var notifiedKeys = new Set();

  var DAY_NAMES = {0:'DIM',1:'LUN',2:'MAR',3:'MER',4:'JEU',5:'VEN',6:'SAM'};
  var REMINDER_LEAD_MIN = 20;

  var EXAMPLE_TASKS = [
    {title:"Relevé des températures chambres froides", time:"08:00", recurrence_type:'daily', recurrence_days:[]},
    {title:"Contrôle entrées/sorties de stock", time:"10:30", recurrence_type:'daily', recurrence_days:[]},
    {title:"Vérification des chariots frigo", time:"14:00", recurrence_type:'days', recurrence_days:[1,2,3,4,5]},
    {title:"Fermeture entrepôt — relevé final", time:"18:00", recurrence_type:'daily', recurrence_days:[]}
  ];

  function pad(n){ return String(n).padStart(2,"0"); }
  function dateKey(d){ d = d || new Date(); return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate()); }
  function dateFromKey(ds){ var p = ds.split("-"); return new Date(+p[0], +p[1]-1, +p[2]); }
  function addDays(d, n){ var c = new Date(d); c.setDate(c.getDate()+n); return c; }
  function taskDateTime(task, ds){
    var hm = task.time.split(":"); var ymd = ds.split("-");
    return new Date(+ymd[0], +ymd[1]-1, +ymd[2], +hm[0], +hm[1], 0, 0);
  }
  function fmtDayLabel(d){ return d.toLocaleDateString('fr-FR',{weekday:'narrow'}).toUpperCase(); }
  function isScheduled(task, date){
    var rec = task.recurrence || {type:'daily'};
    if (rec.type !== 'days') return true;
    return (rec.days || []).indexOf(date.getDay()) !== -1;
  }
  function freqLabel(task){
    var rec = task.recurrence;
    if (!rec || rec.type !== 'days') return '';
    return rec.days.slice().sort().map(function(d){ return DAY_NAMES[d]; }).join('·');
  }
  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  function toast(msg){
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._h);
    toast._h = setTimeout(function(){ t.classList.remove('show'); }, 2600);
  }

  var actx = null;
  function beep(){
    try{
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      var o = actx.createOscillator(), g = actx.createGain();
      o.type = "sine"; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.18, actx.currentTime+0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime+0.35);
      o.connect(g); g.connect(actx.destination);
      o.start(); o.stop(actx.currentTime+0.36);
    }catch(e){}
  }

  // ======================= rendering =======================

  function renderHeaderDate(){
    var el = document.getElementById('today-date');
    var now = new Date();
    var day = now.toLocaleDateString('fr-FR',{weekday:'short'});
    el.textContent = day.replace('.','') + "\n" + pad(now.getDate())+"/"+pad(now.getMonth()+1);
  }

  function allTaskList(){
    return Object.values(tasks).sort(function(a,b){ return a.time.localeCompare(b.time); });
  }
  function todayTaskList(){
    var today = new Date();
    return allTaskList().filter(function(t){ return isScheduled(t, today); });
  }

  function renderRail(){
    var rail = document.getElementById('rail');
    var list = todayTaskList();
    var chips = [];
    list.forEach(function(t){
      if (dueSoon.has(t.id)){
        var dt = taskDateTime(t, dateKey());
        var mins = Math.max(0, Math.round((dt - new Date())/60000));
        chips.push('<div class="rail-chip"><span class="dot"></span>'+escapeHtml(t.title)+' · dans '+mins+' min</div>');
      } else if (overdue.has(t.id)){
        chips.push('<div class="rail-chip overdue"><span class="dot"></span>'+escapeHtml(t.title)+' · en retard</div>');
      }
    });
    rail.innerHTML = chips.join('');
    rail.hidden = chips.length === 0;
  }

  var pendingDelete = null;

  function renderTasks(){
    var list = todayTaskList();
    var ds = dateKey();
    var container = document.getElementById('task-list');
    var doneCount = 0;

    if (list.length === 0){
      var hasAnyTask = Object.keys(tasks).length > 0;
      container.innerHTML = hasAnyTask
        ? '<div class="empty-state">Aucune tâche prévue aujourd\'hui.<br>Regarde l\'onglet Planning pour voir la semaine.</div>'
        : '<div class="empty-state">Aucune tâche aujourd\'hui.<br>Ajoute ta première tâche avec le bouton +.</div>';
      document.getElementById('today-count').textContent = '0/0';
      return;
    }

    var html = list.map(function(t){
      var key = ds + "_" + t.id;
      var log = logs[key];
      var done = !!(log && log.done);
      if (done) doneCount++;
      var cls = 'task-row';
      if (done) cls += ' done';
      else if (dueSoon.has(t.id)) cls += ' due';
      else if (overdue.has(t.id)) cls += ' overdue';

      var delIsConfirm = pendingDelete === t.id;

      return '<div class="'+cls+'" data-id="'+t.id+'">'
        + '<button class="check" data-action="toggle">'
          + '<svg viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        + '</button>'
        + '<div class="task-main">'
          + '<span class="task-title">'+escapeHtml(t.title)+'</span>'
          + '<span class="task-meta">'
            + (overdue.has(t.id) && !done ? '<span class="tag">en retard</span>' : '')
            + (freqLabel(t) ? '<span class="tag">'+freqLabel(t)+'</span>' : '')
            + (t.example ? '<span class="tag">exemple</span>' : '')
          + '</span>'
        + '</div>'
        + '<span class="task-time mono">'+t.time+'</span>'
        + '<button class="task-del'+(delIsConfirm?' confirm':'')+'" data-action="delete">'
          + (delIsConfirm ? 'SUPPR.' : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13"/></svg>')
        + '</button>'
        + '</div>';
    }).join('');

    container.innerHTML = html;
    document.getElementById('today-count').textContent = doneCount + '/' + list.length;
  }

  function scheduledOn(t, ds){
    return t.createdAt.slice(0,10) <= ds && isScheduled(t, dateFromKey(ds));
  }
  function dayFullyDone(ds, list){
    var active = list.filter(function(t){ return scheduledOn(t, ds); });
    if (active.length === 0) return false;
    return active.every(function(t){ var l = logs[ds+"_"+t.id]; return l && l.done; });
  }

  function renderTracker(){
    var list = allTaskList();
    var tracker = document.getElementById('tracker');
    var axis = document.getElementById('tracker-axis');
    var today = new Date();
    var days = [];
    for (var i = 13; i >= 0; i--) days.push(addDays(today, -i));

    if (list.length === 0){
      tracker.innerHTML = '<div class="empty-state">Ton suivi d\'habitudes apparaîtra ici dès que tu auras ajouté des tâches.</div>';
      axis.innerHTML = '';
    } else {
      tracker.innerHTML = list.map(function(t){
        var cells = days.map(function(d){
          var ds = dateKey(d);
          var cls = 'cell';
          if (!scheduledOn(t, ds)){ cls += ' na'; }
          else {
            var log = logs[ds+"_"+t.id];
            var done = log && log.done;
            if (done) cls += ' done';
            else if (ds === dateKey(today)) cls += ' today-pending';
            else cls += ' missed';
          }
          return '<div class="'+cls+'" title="'+ds+'"></div>';
        }).join('');
        return '<div class="tracker-row"><div class="tracker-name">'+escapeHtml(t.title)+'</div><div class="tracker-cells">'+cells+'</div></div>';
      }).join('');
      axis.innerHTML = days.map(function(d,i){
        return (i % 2 === 0) ? '<span>'+fmtDayLabel(d)+'</span>' : '<span></span>';
      }).join('');
    }

    var streak = 0;
    var cursor = new Date(today);
    if (!dayFullyDone(dateKey(cursor), list)) cursor = addDays(cursor, -1);
    while (dayFullyDone(dateKey(cursor), list)){ streak++; cursor = addDays(cursor, -1); }
    document.getElementById('stat-streak').textContent = streak;

    var ds = dateKey(today);
    var activeToday = list.filter(function(t){ return scheduledOn(t, ds); });
    var doneToday = activeToday.filter(function(t){ var l = logs[ds+"_"+t.id]; return l && l.done; }).length;
    var pct = activeToday.length ? Math.round(100*doneToday/activeToday.length) : 0;
    document.getElementById('stat-today').textContent = pct + '%';
  }

  function fmtGroupLabel(d, isToday){
    if (isToday) return "Aujourd'hui";
    var wd = d.toLocaleDateString('fr-FR',{weekday:'long'});
    wd = wd.charAt(0).toUpperCase() + wd.slice(1);
    return wd + ' ' + pad(d.getDate()) + '/' + pad(d.getMonth()+1);
  }

  function renderPlanning(){
    var container = document.getElementById('planning-list');
    var list = allTaskList();
    var today = new Date();
    var html = '';
    var any = false;

    for (var i = 0; i < 14; i++){
      var d = addDays(today, i);
      var ds = dateKey(d);
      var dayTasks = list.filter(function(t){ return scheduledOn(t, ds); });
      if (dayTasks.length === 0) continue;
      any = true;
      var rows = dayTasks.map(function(t){
        var freq = freqLabel(t);
        return '<div class="plan-row">'
          + '<span class="plan-time mono">'+t.time+'</span>'
          + '<span class="plan-title">'+escapeHtml(t.title)+'</span>'
          + (freq ? '<span class="tag">'+freq+'</span>' : '')
          + '</div>';
      }).join('');
      var addRow = '<button type="button" class="plan-add" data-day="'+d.getDay()+'">'
        + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>'
        + 'Ajouter une tâche ce jour</button>';
      html += '<div class="day-group">'
        + '<div class="day-group-header'+(i===0?' today':'')+'">'+fmtGroupLabel(d, i===0)+'<span class="n">· '+dayTasks.length+' tâche'+(dayTasks.length>1?'s':'')+'</span></div>'
        + '<div class="day-card">'+rows+addRow+'</div>'
        + '</div>';
    }

    container.innerHTML = any ? html : '<div class="empty-state">Aucune tâche planifiée pour les 14 prochains jours.<br>Ajoute-en depuis l\'onglet Tâches.</div>';
  }

  function renderAll(){
    renderHeaderDate();
    renderRail();
    renderTasks();
    renderTracker();
    renderPlanning();
  }

  // ======================= reminders (pendant que l'appli est ouverte) =======================

  function checkReminders(){
    var now = new Date();
    var ds = dateKey(now);
    var changed = false;
    todayTaskList().forEach(function(t){
      var key = ds + "_" + t.id;
      var log = logs[key];
      var done = !!(log && log.done);
      if (done){
        if (dueSoon.delete(t.id)) changed = true;
        if (overdue.delete(t.id)) changed = true;
        return;
      }
      var dt = taskDateTime(t, ds);
      var diffMin = (dt - now) / 60000;
      if (diffMin <= REMINDER_LEAD_MIN && diffMin >= 0){
        if (!dueSoon.has(t.id)) changed = true;
        dueSoon.add(t.id); overdue.delete(t.id);
        if (!notifiedKeys.has(key)){
          notifiedKeys.add(key);
          toast((Math.round(diffMin) <= 0 ? 'À faire maintenant : ' : 'Dans '+Math.round(diffMin)+' min : ') + t.title);
          beep();
        }
      } else if (diffMin < 0 && diffMin > -180){
        if (!overdue.has(t.id)) changed = true;
        overdue.add(t.id); dueSoon.delete(t.id);
      } else {
        if (dueSoon.delete(t.id)) changed = true;
        if (overdue.delete(t.id)) changed = true;
      }
    });
    if (changed){ renderRail(); renderTasks(); }
  }

  // ======================= notifications OneSignal (écran verrouillé) =======================

  function refreshNotifBanner(){
    var banner = document.getElementById('notif-banner');
    if (!ONESIGNAL_CONFIGURED){ banner.hidden = true; return; }
    try{
      var OS = window.OneSignal;
      var granted = !!(OS && OS.Notifications && OS.Notifications.permission);
      banner.hidden = granted;
    }catch(e){ banner.hidden = false; }
  }

  document.getElementById('notif-enable').addEventListener('click', function(){
    if (!ONESIGNAL_CONFIGURED){ toast('OneSignal n\'est pas encore configuré (config.js).'); return; }
    try{
      var OS = window.OneSignal;
      if (OS && OS.Notifications && typeof OS.Notifications.requestPermission === 'function'){
        OS.Notifications.requestPermission().then(function(){
          toast('Rappels activés sur ce téléphone.');
          refreshNotifBanner();
        }).catch(function(){ toast('Active les notifications dans les réglages de ton téléphone.'); });
      } else {
        toast('Encore en cours de chargement, réessaie dans quelques secondes.');
      }
    }catch(e){ toast('Impossible d\'activer les rappels pour le moment.'); }
  });

  if (ONESIGNAL_CONFIGURED){
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    window.OneSignalDeferred.push(function(OneSignal){
      window.OneSignal = OneSignal;
      OneSignal.init({ appId: CFG.ONESIGNAL_APP_ID }).then(function(){
        refreshNotifBanner();
        try{
          OneSignal.Notifications.addEventListener('permissionChange', refreshNotifBanner);
        }catch(e){}
      }).catch(function(){});
    });
  }

  // Bouton manuel : reprogramme tout de suite les notifications des tâches
  // (utile après avoir ajouté une tâche pour aujourd'hui, sans attendre le
  // passage automatique du soir).
  document.getElementById('sync-notifs').addEventListener('click', function(){
    var btn = this;
    if (btn.classList.contains('is-syncing')) return;
    btn.classList.add('is-syncing');
    fetch('/api/sync-notifications').then(function(r){ return r.json(); }).then(function(data){
      btn.classList.remove('is-syncing');
      if (!data || data.error){ toast('Synchro impossible pour le moment.'); return; }
      if (data.scheduled > 0){
        toast(data.scheduled + ' notification' + (data.scheduled > 1 ? 's' : '') + ' programmée' + (data.scheduled > 1 ? 's' : '') + '.');
      } else {
        toast('Déjà à jour.');
      }
    }).catch(function(){
      btn.classList.remove('is-syncing');
      toast('Synchro impossible pour le moment.');
    });
  });

  // ======================= Supabase : chargement + écriture =======================

  function rowToTask(row){
    return {
      id: row.id,
      title: row.title,
      time: row.time,
      createdAt: row.created_at,
      example: !!row.example,
      recurrence: { type: row.recurrence_type || 'daily', days: row.recurrence_days || [] }
    };
  }

  var splashTasksLoaded = false, splashLogsLoaded = false, splashReady = false, splashProgress = 0, splashTimer = null;
  function splashMarkReady(){ splashReady = true; }
  function splashTick(){
    if (!splashReady){
      var target = 92;
      splashProgress += (target - splashProgress) * 0.05 + 0.25;
      if (splashProgress > target) splashProgress = target;
    } else { splashProgress += 7; }
    var p = Math.min(100, Math.round(splashProgress));
    var bar = document.getElementById('splash-bar');
    var pct = document.getElementById('splash-pct');
    if (bar) bar.style.width = p + '%';
    if (pct) pct.textContent = p + '%';
    if (splashProgress >= 100){ clearInterval(splashTimer); splashFinish(); }
  }
  function splashFinish(){
    var el = document.getElementById('splash');
    if (!el) return;
    setTimeout(function(){
      el.classList.add('hide');
      setTimeout(function(){ el.remove(); }, 500);
    }, 150);
  }

  async function loadTasks(){
    if (!sb) return;
    var res = await sb.from('tasks').select('*');
    if (res.error){ toast('Erreur de chargement des tâches.'); return; }
    var next = {};
    (res.data || []).forEach(function(row){ next[row.id] = rowToTask(row); });
    tasks = next;
    renderAll();
    await seedExamplesIfEmpty();
  }

  async function loadLogs(){
    if (!sb) return;
    var cutoff = dateKey(addDays(new Date(), -13));
    var res = await sb.from('logs').select('*').gte('date', cutoff);
    if (res.error){ toast('Erreur de chargement du suivi.'); return; }
    var next = {};
    (res.data || []).forEach(function(row){ next[row.id] = { date: row.date, taskId: row.task_id, done: !!row.done }; });
    logs = next;
    renderAll();
    checkReminders();
  }

  async function seedExamplesIfEmpty(){
    if (Object.keys(tasks).length > 0) return;
    var rows = EXAMPLE_TASKS.map(function(ex){
      return { title: ex.title, time: ex.time, recurrence_type: ex.recurrence_type, recurrence_days: ex.recurrence_days, example: true };
    });
    var res = await sb.from('tasks').insert(rows).select();
    if (!res.error){
      (res.data || []).forEach(function(row){ tasks[row.id] = rowToTask(row); });
      renderAll();
    }
  }

  async function addTask(title, time, recurrence){
    if (!sb) return;
    var res = await sb.from('tasks').insert({
      title: title, time: time,
      recurrence_type: recurrence.type,
      recurrence_days: recurrence.type === 'days' ? recurrence.days : []
    }).select();
    if (res.error){ toast('Ajout impossible.'); return; }
    var row = res.data && res.data[0];
    if (row){ tasks[row.id] = rowToTask(row); renderAll(); }
  }

  async function deleteTask(id){
    if (!sb) return;
    delete tasks[id];
    renderAll();
    var res = await sb.from('tasks').delete().eq('id', id);
    if (res.error) toast('Suppression impossible.');
  }

  async function toggleTask(id){
    if (!sb) return;
    var ds = dateKey();
    var key = ds + "_" + id;
    var log = logs[key];
    var willBeDone = !(log && log.done);
    logs[key] = { date: ds, taskId: id, done: willBeDone };
    renderTasks(); renderTracker(); checkReminders();
    if (willBeDone){
      var res = await sb.from('logs').upsert({ id: key, task_id: id, date: ds, done: true, done_at: new Date().toISOString() });
      if (res.error) toast('Impossible d\'enregistrer.');
    } else {
      var res2 = await sb.from('logs').delete().eq('id', key);
      if (res2.error) toast('Impossible d\'enregistrer.');
    }
  }

  function wireRealtime(){
    if (!sb) return;
    sb.channel('tasks-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, function(){ loadTasks(); })
      .subscribe();
    sb.channel('logs-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'logs' }, function(){ loadLogs(); })
      .subscribe();
  }

  // ======================= UI wiring =======================

  document.getElementById('task-list').addEventListener('click', function(e){
    var row = e.target.closest('.task-row');
    if (!row) return;
    var id = row.getAttribute('data-id');
    var action = e.target.closest('[data-action]');
    if (!action) return;
    if (action.dataset.action === 'toggle'){ pendingDelete = null; toggleTask(id); }
    else if (action.dataset.action === 'delete'){
      if (pendingDelete === id){ pendingDelete = null; deleteTask(id); }
      else {
        pendingDelete = id; renderTasks();
        setTimeout(function(){ if (pendingDelete === id){ pendingDelete = null; renderTasks(); } }, 3000);
      }
    }
  });

  document.querySelectorAll('.tab').forEach(function(btn){
    btn.addEventListener('click', function(){
      document.querySelectorAll('.tab').forEach(function(b){ b.classList.remove('active'); });
      btn.classList.add('active');
      var tab = btn.dataset.tab;
      document.getElementById('view-tasks').hidden = tab !== 'tasks';
      document.getElementById('view-planning').hidden = tab !== 'planning';
      document.getElementById('view-tracker').hidden = tab !== 'tracker';
    });
  });

  var sheet = document.getElementById('sheet');
  var sheetBackdrop = document.getElementById('sheet-backdrop');
  var dayPicker = document.getElementById('day-picker');
  var freqMode = 'daily';
  var selectedDays = new Set();

  function setFreqMode(mode){
    freqMode = mode;
    document.querySelectorAll('.seg-btn').forEach(function(b){ b.classList.toggle('active', b.dataset.freq === mode); });
    dayPicker.hidden = mode !== 'days';
  }
  document.querySelectorAll('.seg-btn').forEach(function(b){ b.addEventListener('click', function(){ setFreqMode(b.dataset.freq); }); });
  document.querySelectorAll('.day-chip').forEach(function(chip){
    chip.addEventListener('click', function(){
      var d = +chip.dataset.day;
      if (selectedDays.has(d)){ selectedDays.delete(d); chip.classList.remove('active'); }
      else { selectedDays.add(d); chip.classList.add('active'); }
    });
  });

  function openSheet(presetDay){
    document.getElementById('f-title').value = '';
    document.getElementById('f-time').value = '09:00';
    selectedDays = new Set();
    document.querySelectorAll('.day-chip').forEach(function(c){ c.classList.remove('active'); });
    if (presetDay !== undefined && presetDay !== null){
      setFreqMode('days');
      selectedDays.add(presetDay);
      var chip = document.querySelector('.day-chip[data-day="'+presetDay+'"]');
      if (chip) chip.classList.add('active');
    } else { setFreqMode('daily'); }
    sheet.classList.add('open'); sheetBackdrop.classList.add('open');
    setTimeout(function(){ document.getElementById('f-title').focus(); }, 260);
  }
  function closeSheet(){ sheet.classList.remove('open'); sheetBackdrop.classList.remove('open'); }
  document.getElementById('fab').addEventListener('click', function(){ openSheet(); });
  document.getElementById('planning-list').addEventListener('click', function(e){
    var btn = e.target.closest('.plan-add');
    if (!btn) return;
    openSheet(+btn.dataset.day);
  });
  document.getElementById('f-cancel').addEventListener('click', closeSheet);
  sheetBackdrop.addEventListener('click', closeSheet);
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape' && sheet.classList.contains('open')) closeSheet(); });
  document.getElementById('f-save').addEventListener('click', function(){
    var title = document.getElementById('f-title').value.trim();
    var time = document.getElementById('f-time').value || '09:00';
    if (!title){ toast('Donne un nom à la tâche.'); return; }
    var recurrence;
    if (freqMode === 'days'){
      if (selectedDays.size === 0){ toast('Choisis au moins un jour.'); return; }
      recurrence = { type:'days', days: Array.from(selectedDays) };
    } else { recurrence = { type:'daily' }; }
    addTask(title, time, recurrence);
    closeSheet();
  });

  // ======================= boot =======================

  function boot(){
    renderHeaderDate();
    refreshNotifBanner();
    renderAll();

    if (!CONFIGURED){
      toast('Configuration à terminer dans config.js.');
      return;
    }

    splashTimer = setInterval(splashTick, 60);
    setTimeout(splashMarkReady, 4000);

    Promise.all([loadTasks(), loadLogs()]).then(function(){
      splashTasksLoaded = true; splashLogsLoaded = true; splashMarkReady();
    }).catch(function(){ splashMarkReady(); });

    wireRealtime();
    setInterval(function(){ renderHeaderDate(); checkReminders(); }, 20000);
    setInterval(function(){ renderTracker(); renderPlanning(); }, 60000);
  }

  boot();
})();
