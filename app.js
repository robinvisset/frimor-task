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

  var session = null;        // {id, name, is_admin}
  var employees = {};        // id -> {id,name,is_admin}
  var assignees = {};        // taskId -> Set(employeeId), pour les tâches obligatoires
  var loginSelectedId = null;
  var viewAsId = null;       // id de l'employé consulté par le patron (lecture seule), ou null = vue de soi-même

  function viewingEmployeeId(){ return viewAsId || (session && session.id); }
  function isReadOnlyView(){ return !!viewAsId; }

  var tasks = {};   // id -> {id,title,time,createdAt,example,recurrence:{type,days},ownerEmployeeId,isMandatory}
  var logs = {};    // "date_taskId_employeeId" -> {date,taskId,done}
  var todayLogsAll = {}; // pour le tableau de bord patron : "date_taskId_employeeId" -> done, pour TOUS les employés, jour courant
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
  function logKey(taskId, ds){ return ds + "_" + taskId + "_" + (viewingEmployeeId() || ''); }

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

  // ======================= session / login =======================

  function saveSession(s){ try{ localStorage.setItem('frimor_session', JSON.stringify(s)); }catch(e){} }
  function getSavedSession(){ try{ var raw = localStorage.getItem('frimor_session'); return raw ? JSON.parse(raw) : null; }catch(e){ return null; } }
  function clearSession(){ try{ localStorage.removeItem('frimor_session'); }catch(e){} }

  function renderLoginNames(){
    var box = document.getElementById('login-names');
    var list = Object.values(employees).sort(function(a,b){ return a.name.localeCompare(b.name,'fr'); });
    box.innerHTML = list.length
      ? list.map(function(e){ return '<button type="button" class="login-name-btn" data-id="'+e.id+'">'+escapeHtml(e.name)+'</button>'; }).join('')
      : '<div class="empty-state">Aucun compte pour l\'instant.</div>';
  }

  document.getElementById('login-names').addEventListener('click', function(e){
    var btn = e.target.closest('.login-name-btn');
    if (!btn) return;
    loginSelectedId = btn.dataset.id;
    var emp = employees[loginSelectedId];
    document.getElementById('login-pin-name').textContent = emp ? emp.name : '';
    document.getElementById('login-names-step').hidden = true;
    document.getElementById('login-pin-step').hidden = false;
    document.getElementById('login-error').hidden = true;
    var input = document.getElementById('login-pin-input');
    input.value = '';
    setTimeout(function(){ input.focus(); }, 150);
  });

  document.getElementById('login-back').addEventListener('click', function(){
    document.getElementById('login-pin-step').hidden = true;
    document.getElementById('login-names-step').hidden = false;
    document.getElementById('login-pin-input').value = '';
  });

  document.getElementById('login-pin-input').addEventListener('input', function(){
    var v = this.value.replace(/\D/g,'').slice(0,4);
    this.value = v;
    document.getElementById('login-error').hidden = true;
    if (v.length === 4){ attemptLogin(loginSelectedId, v); }
  });

  function attemptLogin(id, pin){
    if (!sb || !id) return;
    sb.from('employees').select('id,name,is_admin,pin').eq('id', id).single().then(function(res){
      if (res.error || !res.data || String(res.data.pin) !== pin){
        document.getElementById('login-error').hidden = false;
        document.getElementById('login-pin-input').value = '';
        return;
      }
      session = { id: res.data.id, name: res.data.name, is_admin: !!res.data.is_admin };
      enterApp();
    }).catch(function(){
      document.getElementById('login-error').hidden = false;
    });
  }

  document.getElementById('user-chip').addEventListener('click', function(){
    clearSession();
    location.reload();
  });

  function enterApp(){
    document.getElementById('login-screen').hidden = true;
    document.getElementById('user-chip').hidden = false;
    document.getElementById('user-chip-name').textContent = session.name;
    document.getElementById('tab-admin').hidden = !session.is_admin;
    saveSession(session);
    syncPlayerIdSoon();

    loadAssignees().then(function(){
      return Promise.all([loadTasks(), loadLogs()]);
    }).then(function(){
      splashTasksLoaded = true; splashLogsLoaded = true; splashMarkReady();
    }).catch(function(){ splashMarkReady(); });

    wireRealtime();
    setInterval(function(){ renderHeaderDate(); checkReminders(); }, 20000);
    setInterval(function(){
      renderTracker(); renderPlanning();
      if (session && session.is_admin) loadDashboardLogs();
    }, 60000);
  }

  // ======================= rendering =======================

  function renderHeaderDate(){
    var el = document.getElementById('today-date');
    var now = new Date();
    var day = now.toLocaleDateString('fr-FR',{weekday:'short'});
    el.textContent = day.replace('.','') + "\n" + pad(now.getDate())+"/"+pad(now.getMonth()+1);
  }

  function allTaskList(){
    if (!session) return [];
    var eid = viewingEmployeeId();
    return Object.values(tasks).filter(function(t){
      if (t.isMandatory) return assignees[t.id] && assignees[t.id].has(eid);
      return t.ownerEmployeeId === eid;
    }).sort(function(a,b){ return a.time.localeCompare(b.time); });
  }
  function todayTaskList(){
    var today = new Date();
    return allTaskList().filter(function(t){ return isScheduled(t, today); });
  }

  // comme allTaskList(), mais pour un employé précis (pas forcément celui
  // de la session) — utilisé par le tableau de bord du patron.
  function employeeTasksFor(employeeId){
    return Object.values(tasks).filter(function(t){
      if (t.isMandatory) return assignees[t.id] && assignees[t.id].has(employeeId);
      return t.ownerEmployeeId === employeeId;
    }).sort(function(a,b){ return a.time.localeCompare(b.time); });
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

    var ro = isReadOnlyView();

    if (list.length === 0){
      var hasAnyTask = allTaskList().length > 0;
      container.innerHTML = ro
        ? '<div class="empty-state">Aucune tâche prévue aujourd\'hui pour cet employé.</div>'
        : (hasAnyTask
          ? '<div class="empty-state">Aucune tâche prévue aujourd\'hui.<br>Regarde l\'onglet Planning pour voir la semaine.</div>'
          : '<div class="empty-state">Aucune tâche aujourd\'hui.<br>Ajoute ta première tâche avec le bouton +.</div>');
      document.getElementById('today-count').textContent = '0/0';
      var bar0 = document.getElementById('today-progress');
      if (bar0) bar0.style.width = '0%';
      return;
    }

    var html = list.map(function(t){
      var key = logKey(t.id, ds);
      var log = logs[key];
      var done = !!(log && log.done);
      if (done) doneCount++;
      var cls = 'task-row';
      if (done) cls += ' done';
      else if (dueSoon.has(t.id)) cls += ' due';
      else if (overdue.has(t.id)) cls += ' overdue';

      var delIsConfirm = pendingDelete === t.id;

      return '<div class="'+cls+'" data-id="'+t.id+'">'
        + '<button class="check"'+(ro ? '' : ' data-action="toggle"')+'>'
          + '<svg viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        + '</button>'
        + '<div class="task-main">'
          + '<span class="task-title">'+escapeHtml(t.title)+'</span>'
          + '<span class="task-meta">'
            + (overdue.has(t.id) && !done ? '<span class="tag">en retard</span>' : '')
            + (freqLabel(t) ? '<span class="tag">'+freqLabel(t)+'</span>' : '')
            + (t.isMandatory ? '<span class="tag">obligatoire</span>' : '')
            + (t.example ? '<span class="tag">exemple</span>' : '')
          + '</span>'
        + '</div>'
        + '<span class="task-time mono">'+t.time+'</span>'
        + (t.isMandatory || ro ? '' : '<button class="task-del'+(delIsConfirm?' confirm':'')+'" data-action="delete">'
          + (delIsConfirm ? 'SUPPR.' : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13"/></svg>')
          + '</button>')
        + '</div>';
    }).join('');

    container.innerHTML = html;
    document.getElementById('today-count').textContent = doneCount + '/' + list.length;
    var pct = list.length ? Math.round(100 * doneCount / list.length) : 0;
    var bar = document.getElementById('today-progress');
    if (bar) bar.style.width = pct + '%';
  }

  function scheduledOn(t, ds){
    return t.createdAt.slice(0,10) <= ds && isScheduled(t, dateFromKey(ds));
  }
  function dayFullyDone(ds, list){
    var active = list.filter(function(t){ return scheduledOn(t, ds); });
    if (active.length === 0) return false;
    return active.every(function(t){ var l = logs[logKey(t.id, ds)]; return l && l.done; });
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
            var log = logs[logKey(t.id, ds)];
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
    var doneToday = activeToday.filter(function(t){ var l = logs[logKey(t.id, ds)]; return l && l.done; }).length;
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
    var ro = isReadOnlyView();

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
          + (t.isMandatory ? '<span class="tag">obligatoire</span>' : '')
          + '</div>';
      }).join('');
      var addRow = ro ? '' : '<button type="button" class="plan-add" data-day="'+d.getDay()+'">'
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
    if (isReadOnlyView()) return;
    var now = new Date();
    var ds = dateKey(now);
    var changed = false;
    todayTaskList().forEach(function(t){
      var key = logKey(t.id, ds);
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

  function currentOneSignalId(){
    try{
      if (window.OneSignal && window.OneSignal.User && window.OneSignal.User.PushSubscription){
        return window.OneSignal.User.PushSubscription.id || null;
      }
    }catch(e){}
    return null;
  }

  function syncPlayerIdToEmployee(){
    if (!sb || !session) return;
    var pid = currentOneSignalId();
    if (!pid) return;
    sb.from('employees').select('player_ids').eq('id', session.id).single().then(function(res){
      if (res.error || !res.data) return;
      var ids = res.data.player_ids || [];
      if (ids.indexOf(pid) !== -1) return;
      ids.push(pid);
      sb.from('employees').update({ player_ids: ids }).eq('id', session.id).then(function(){});
    }).catch(function(){});
  }
  function syncPlayerIdSoon(){ setTimeout(syncPlayerIdToEmployee, 1500); }

  document.getElementById('notif-enable').addEventListener('click', function(){
    if (!ONESIGNAL_CONFIGURED){ toast('OneSignal n\'est pas encore configuré (config.js).'); return; }
    try{
      var OS = window.OneSignal;
      if (OS && OS.Notifications && typeof OS.Notifications.requestPermission === 'function'){
        OS.Notifications.requestPermission().then(function(){
          toast('Rappels activés sur ce téléphone.');
          refreshNotifBanner();
          syncPlayerIdSoon();
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
        syncPlayerIdSoon();
        try{
          OneSignal.Notifications.addEventListener('permissionChange', function(){
            refreshNotifBanner();
            syncPlayerIdSoon();
          });
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
      recurrence: { type: row.recurrence_type || 'daily', days: row.recurrence_days || [] },
      ownerEmployeeId: row.owner_employee_id || null,
      isMandatory: !!row.is_mandatory
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

  function loadEmployees(){
    if (!sb) return Promise.resolve();
    return sb.from('employees').select('id,name,is_admin').then(function(res){
      if (res.error) return;
      var next = {};
      (res.data || []).forEach(function(row){ next[row.id] = { id: row.id, name: row.name, is_admin: !!row.is_admin }; });
      employees = next;
      if (session && session.is_admin){ renderAdminEmployees(); }
      if (!session){ renderLoginNames(); }
    });
  }

  function loadAssignees(){
    if (!sb) return Promise.resolve();
    return sb.from('task_assignees').select('task_id,employee_id').then(function(res){
      if (res.error) return;
      var next = {};
      (res.data || []).forEach(function(row){
        if (!next[row.task_id]) next[row.task_id] = new Set();
        next[row.task_id].add(row.employee_id);
      });
      assignees = next;
      renderAll();
      if (session && session.is_admin){ renderAdminTasks(); }
    });
  }

  async function loadTasks(){
    if (!sb) return;
    var res = await sb.from('tasks').select('*');
    if (res.error){ toast('Erreur de chargement des tâches.'); return; }
    var next = {};
    (res.data || []).forEach(function(row){ next[row.id] = rowToTask(row); });
    tasks = next;
    renderAll();
    if (session && session.is_admin){ renderAdminTasks(); }
    await seedExamplesIfEmpty();
  }

  async function loadLogsFor(employeeId){
    if (!sb || !employeeId) return;
    var cutoff = dateKey(addDays(new Date(), -13));
    var res = await sb.from('logs').select('*').eq('employee_id', employeeId).gte('date', cutoff);
    if (res.error){ toast('Erreur de chargement du suivi.'); return; }
    // Si la vue a changé pendant le chargement (ex. le patron a déjà quitté
    // ou changé d'employé consulté), on ignore ce résultat devenu obsolète.
    if (employeeId !== viewingEmployeeId()) return;
    var next = {};
    (res.data || []).forEach(function(row){ next[row.id] = { date: row.date, taskId: row.task_id, done: !!row.done }; });
    logs = next;
    renderAll();
    checkReminders();
  }
  function loadLogs(){ return loadLogsFor(session ? session.id : null); }

  // Pour le tableau de bord du patron : l'état fait/pas fait d'AUJOURD'HUI,
  // pour tous les employés (une seule requête légère, pas 14 jours).
  async function loadDashboardLogs(){
    if (!sb || !session || !session.is_admin) return;
    var ds = dateKey();
    var res = await sb.from('logs').select('id,done').eq('date', ds);
    if (res.error) return;
    var next = {};
    (res.data || []).forEach(function(row){ next[row.id] = !!row.done; });
    todayLogsAll = next;
    renderAdminDashboard();
  }

  async function seedExamplesIfEmpty(){
    if (!session) return;
    if (allTaskList().length > 0) return;
    var rows = EXAMPLE_TASKS.map(function(ex){
      return { title: ex.title, time: ex.time, recurrence_type: ex.recurrence_type, recurrence_days: ex.recurrence_days, example: true, owner_employee_id: session.id, is_mandatory: false };
    });
    var res = await sb.from('tasks').insert(rows).select();
    if (!res.error){
      (res.data || []).forEach(function(row){ tasks[row.id] = rowToTask(row); });
      renderAll();
    }
  }

  async function addTask(title, time, recurrence){
    if (!sb || !session || isReadOnlyView()) return;
    var res = await sb.from('tasks').insert({
      title: title, time: time,
      recurrence_type: recurrence.type,
      recurrence_days: recurrence.type === 'days' ? recurrence.days : [],
      owner_employee_id: session.id,
      is_mandatory: false
    }).select();
    if (res.error){ toast('Ajout impossible.'); return; }
    var row = res.data && res.data[0];
    if (row){ tasks[row.id] = rowToTask(row); renderAll(); }
  }

  async function deleteTask(id){
    if (!sb || isReadOnlyView()) return;
    var t = tasks[id];
    if (t && t.isMandatory && !(session && session.is_admin)){ toast('Seul le patron peut supprimer une tâche obligatoire.'); return; }
    delete tasks[id];
    delete assignees[id];
    renderAll();
    if (session && session.is_admin) renderAdminTasks();
    var res = await sb.from('tasks').delete().eq('id', id);
    if (res.error) toast('Suppression impossible.');
  }

  async function toggleTask(id){
    if (!sb || !session || isReadOnlyView()) return;
    var ds = dateKey();
    var key = logKey(id, ds);
    var log = logs[key];
    var willBeDone = !(log && log.done);
    logs[key] = { date: ds, taskId: id, done: willBeDone };
    renderTasks(); renderTracker(); checkReminders();
    if (willBeDone){
      var res = await sb.from('logs').upsert({ id: key, task_id: id, date: ds, done: true, done_at: new Date().toISOString(), employee_id: session.id });
      if (res.error) toast('Impossible d\'enregistrer.');
    } else {
      var res2 = await sb.from('logs').delete().eq('id', key);
      if (res2.error) toast('Impossible d\'enregistrer.');
    }
  }

  async function deleteEmployee(id){
    if (!sb) return;
    var res = await sb.from('employees').delete().eq('id', id);
    if (res.error){ toast('Suppression impossible.'); return; }
    delete employees[id];
    renderAdminEmployees();
    toast('Employé supprimé.');
  }

  function wireRealtime(){
    if (!sb) return;
    sb.channel('tasks-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, function(){ loadTasks(); })
      .subscribe();
    sb.channel('logs-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'logs' }, function(){
        loadLogsFor(viewingEmployeeId());
        if (session && session.is_admin) loadDashboardLogs();
      })
      .subscribe();
    sb.channel('employees-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'employees' }, function(){ loadEmployees(); })
      .subscribe();
    sb.channel('assignees-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_assignees' }, function(){ loadAssignees(); })
      .subscribe();
  }

  // ======================= UI wiring : tâches (employé) =======================

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
      var tab = btn.dataset.tab;
      if (tab === 'admin' && viewAsId){ exitViewAs(); }
      document.querySelectorAll('.tab').forEach(function(b){ b.classList.remove('active'); });
      btn.classList.add('active');
      document.getElementById('view-tasks').hidden = tab !== 'tasks';
      document.getElementById('view-planning').hidden = tab !== 'planning';
      document.getElementById('view-tracker').hidden = tab !== 'tracker';
      document.getElementById('view-admin').hidden = tab !== 'admin';
      if (tab === 'admin'){ renderAdminEmployees(); renderAdminTasks(); loadDashboardLogs(); }
    });
  });

  // ======================= vue "consulter un employé" (patron, lecture seule) =======================

  function enterViewAs(employeeId){
    var emp = employees[employeeId];
    if (!emp || !session || !session.is_admin) return;
    viewAsId = employeeId;
    pendingDelete = null;

    document.getElementById('view-as-text').textContent = 'Vue de ' + emp.name + ' — lecture seule';
    document.getElementById('view-as-banner').hidden = false;
    document.getElementById('fab').hidden = true;

    document.querySelectorAll('.tab').forEach(function(b){ b.classList.remove('active'); });
    var tasksTabBtn = document.querySelector('.tab[data-tab="tasks"]');
    if (tasksTabBtn) tasksTabBtn.classList.add('active');
    document.getElementById('view-tasks').hidden = false;
    document.getElementById('view-planning').hidden = true;
    document.getElementById('view-tracker').hidden = true;
    document.getElementById('view-admin').hidden = true;

    renderAll();
    loadLogsFor(employeeId);
  }

  function exitViewAs(){
    if (!viewAsId) return;
    viewAsId = null;
    pendingDelete = null;
    document.getElementById('view-as-banner').hidden = true;
    document.getElementById('fab').hidden = false;
    loadLogs();
    renderAll();
  }
  document.getElementById('view-as-exit').addEventListener('click', exitViewAs);

  var sheet = document.getElementById('sheet');
  var sheetBackdrop = document.getElementById('sheet-backdrop');
  var dayPicker = document.getElementById('day-picker');
  var freqMode = 'daily';
  var selectedDays = new Set();

  function setFreqMode(mode){
    freqMode = mode;
    document.querySelectorAll('#freq-seg .seg-btn').forEach(function(b){ b.classList.toggle('active', b.dataset.freq === mode); });
    dayPicker.hidden = mode !== 'days';
  }
  document.querySelectorAll('#freq-seg .seg-btn').forEach(function(b){ b.addEventListener('click', function(){ setFreqMode(b.dataset.freq); }); });
  document.querySelectorAll('#day-picker .day-chip').forEach(function(chip){
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
    document.querySelectorAll('#day-picker .day-chip').forEach(function(c){ c.classList.remove('active'); });
    if (presetDay !== undefined && presetDay !== null){
      setFreqMode('days');
      selectedDays.add(presetDay);
      var chip = document.querySelector('#day-picker .day-chip[data-day="'+presetDay+'"]');
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
  document.addEventListener('keydown', function(e){
    if (e.key !== 'Escape') return;
    if (sheet.classList.contains('open')) closeSheet();
    if (sheetEmp.classList.contains('open')) closeSheetEmp();
    if (sheetMt.classList.contains('open')) closeSheetMt();
  });
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

  // ======================= UI wiring : espace Gestion (patron) =======================

  var pendingDeleteEmp = null;
  var pendingDeleteMTask = null;

  // Vue d'ensemble pour le patron : où en est chaque employé aujourd'hui,
  // sans avoir à cliquer sur chacun (l'œil "Voir" reste disponible pour le détail).
  function renderAdminDashboard(){
    var box = document.getElementById('admin-dashboard-list');
    if (!box) return;
    var ds = dateKey();
    var now = new Date();
    var list = Object.values(employees).filter(function(e){ return !e.is_admin; }).sort(function(a,b){ return a.name.localeCompare(b.name,'fr'); });
    if (list.length === 0){ box.innerHTML = '<div class="empty-state">Aucun employé pour l\'instant.</div>'; return; }
    box.innerHTML = list.map(function(e){
      var empTasks = employeeTasksFor(e.id).filter(function(t){ return isScheduled(t, now); });
      var done = 0, lateMandatory = false;
      empTasks.forEach(function(t){
        var key = ds + '_' + t.id + '_' + e.id;
        if (todayLogsAll[key]){ done++; return; }
        if (t.isMandatory && taskDateTime(t, ds).getTime() < now.getTime()) lateMandatory = true;
      });
      var total = empTasks.length;
      var dotCls = lateMandatory ? ' alert' : (total > 0 && done === total ? ' ok' : '');
      var subCls = lateMandatory ? ' alert-text' : '';
      return '<div class="dash-row'+(lateMandatory?' alert':'')+'">'
        + '<div class="dash-row-main"><div class="dash-row-name">'+escapeHtml(e.name)+'</div>'
        + '<div class="dash-row-sub'+subCls+'">'+done+'/'+total+' tâche'+(total===1?'':'s')+' aujourd\'hui'+(lateMandatory ? ' · obligatoire en retard' : '')+'</div></div>'
        + '<div class="dash-row-dot'+dotCls+'"></div>'
        + '</div>';
    }).join('');
  }

  function renderAdminEmployees(){
    var box = document.getElementById('admin-employee-list');
    if (!box) return;
    var list = Object.values(employees).sort(function(a,b){ return a.name.localeCompare(b.name,'fr'); });
    if (list.length === 0){ box.innerHTML = '<div class="empty-state">Aucun employé pour l\'instant.</div>'; return; }
    box.innerHTML = list.map(function(e){
      var confirm = pendingDeleteEmp === e.id;
      var isSelf = session && e.id === session.id;
      return '<div class="admin-row" data-id="'+e.id+'">'
        + '<div class="admin-row-main"><div class="admin-row-title">'+escapeHtml(e.name)+'</div>'
        + (e.is_admin ? '<div class="admin-row-meta">Administrateur</div>' : '') + '</div>'
        + (isSelf ? '' : '<button class="admin-row-view" data-action="view-employee" aria-label="Voir ses tâches">'
          + '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>'
          + '</button>')
        + (e.is_admin ? '' : '<button class="admin-row-del'+(confirm?' confirm':'')+'" data-action="delete-employee">'
          + (confirm ? 'SUPPR.' : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13"/></svg>')
          + '</button>')
        + '</div>';
    }).join('');
  }

  function mandatoryTaskList(){
    return Object.values(tasks).filter(function(t){ return t.isMandatory; }).sort(function(a,b){ return a.time.localeCompare(b.time); });
  }

  function renderAdminTasks(){
    var box = document.getElementById('admin-task-list');
    if (!box) return;
    var list = mandatoryTaskList();
    if (list.length === 0){ box.innerHTML = '<div class="empty-state">Aucune tâche obligatoire pour l\'instant.</div>'; return; }
    box.innerHTML = list.map(function(t){
      var names = Array.from(assignees[t.id] || []).map(function(id){ return employees[id] ? employees[id].name : '?'; }).join(', ');
      var confirm = pendingDeleteMTask === t.id;
      return '<div class="admin-row" data-id="'+t.id+'">'
        + '<div class="admin-row-main"><div class="admin-row-title">'+escapeHtml(t.title)+' · '+t.time+'</div>'
        + '<div class="admin-row-meta">'+(names || 'Personne')+'</div></div>'
        + '<button class="admin-row-dup" data-action="duplicate-mtask" aria-label="Dupliquer cette tâche">'
          + '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
        + '</button>'
        + '<button class="admin-row-del'+(confirm?' confirm':'')+'" data-action="delete-mtask">'
          + (confirm ? 'SUPPR.' : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13"/></svg>')
        + '</button></div>';
    }).join('');
  }

  document.getElementById('admin-employee-list').addEventListener('click', function(e){
    var row = e.target.closest('.admin-row'); if (!row) return;
    var id = row.dataset.id;
    var action = e.target.closest('[data-action]'); if (!action) return;
    if (action.dataset.action === 'view-employee'){
      enterViewAs(id);
    } else if (action.dataset.action === 'delete-employee'){
      if (pendingDeleteEmp === id){ pendingDeleteEmp = null; deleteEmployee(id); }
      else {
        pendingDeleteEmp = id; renderAdminEmployees();
        setTimeout(function(){ if (pendingDeleteEmp === id){ pendingDeleteEmp = null; renderAdminEmployees(); } }, 3000);
      }
    }
  });

  document.getElementById('admin-task-list').addEventListener('click', function(e){
    var row = e.target.closest('.admin-row'); if (!row) return;
    var id = row.dataset.id;
    var action = e.target.closest('[data-action]'); if (!action) return;
    if (action.dataset.action === 'duplicate-mtask'){
      var t = tasks[id];
      if (t) openMtSheet(t);
    } else if (action.dataset.action === 'delete-mtask'){
      if (pendingDeleteMTask === id){ pendingDeleteMTask = null; deleteTask(id); }
      else {
        pendingDeleteMTask = id; renderAdminTasks();
        setTimeout(function(){ if (pendingDeleteMTask === id){ pendingDeleteMTask = null; renderAdminTasks(); } }, 3000);
      }
    }
  });

  // --- ajouter un employé ---
  var sheetEmp = document.getElementById('sheet-employee');
  var sheetEmpBackdrop = document.getElementById('sheet-employee-backdrop');
  function closeSheetEmp(){ sheetEmp.classList.remove('open'); sheetEmpBackdrop.classList.remove('open'); }
  document.getElementById('admin-add-employee').addEventListener('click', function(){
    document.getElementById('emp-name').value = '';
    document.getElementById('emp-pin').value = '';
    sheetEmp.classList.add('open'); sheetEmpBackdrop.classList.add('open');
  });
  document.getElementById('emp-cancel').addEventListener('click', closeSheetEmp);
  sheetEmpBackdrop.addEventListener('click', closeSheetEmp);
  document.getElementById('emp-save').addEventListener('click', async function(){
    var name = document.getElementById('emp-name').value.trim();
    var pin = document.getElementById('emp-pin').value.trim();
    if (!name){ toast('Donne un nom.'); return; }
    if (!/^\d{4}$/.test(pin)){ toast('Le code doit avoir 4 chiffres.'); return; }
    var res = await sb.from('employees').insert({ name: name, pin: pin, is_admin: false }).select();
    if (res.error){ toast(res.error.code === '23505' ? 'Ce nom existe déjà.' : 'Ajout impossible.'); return; }
    var row = res.data && res.data[0];
    if (row) employees[row.id] = { id: row.id, name: row.name, is_admin: false };
    renderAdminEmployees();
    closeSheetEmp();
    toast('Employé ajouté.');
  });

  // --- créer une tâche obligatoire ---
  var sheetMt = document.getElementById('sheet-mtask');
  var sheetMtBackdrop = document.getElementById('sheet-mtask-backdrop');
  var mtDayPicker = document.getElementById('mt-day-picker');
  var mtFreqMode = 'daily';
  var mtSelectedDays = new Set();
  var mtSelectedEmployees = new Set();

  function setMtFreqMode(mode){
    mtFreqMode = mode;
    document.querySelectorAll('#mt-freq-seg .seg-btn').forEach(function(b){ b.classList.toggle('active', b.dataset.freq === mode); });
    mtDayPicker.hidden = mode !== 'days';
  }
  document.querySelectorAll('#mt-freq-seg .seg-btn').forEach(function(b){ b.addEventListener('click', function(){ setMtFreqMode(b.dataset.freq); }); });
  document.querySelectorAll('#mt-day-picker .day-chip').forEach(function(chip){
    chip.addEventListener('click', function(){
      var d = +chip.dataset.day;
      if (mtSelectedDays.has(d)){ mtSelectedDays.delete(d); chip.classList.remove('active'); }
      else { mtSelectedDays.add(d); chip.classList.add('active'); }
    });
  });

  function renderMtEmployeePicker(){
    var box = document.getElementById('mt-employee-picker');
    var list = Object.values(employees).sort(function(a,b){ return a.name.localeCompare(b.name,'fr'); });
    box.innerHTML = list.map(function(e){
      return '<button type="button" class="mt-emp-chip'+(mtSelectedEmployees.has(e.id)?' active':'')+'" data-id="'+e.id+'">'+escapeHtml(e.name)+'</button>';
    }).join('');
  }
  document.getElementById('mt-employee-picker').addEventListener('click', function(e){
    var chip = e.target.closest('.mt-emp-chip'); if (!chip) return;
    var id = chip.dataset.id;
    if (mtSelectedEmployees.has(id)){ mtSelectedEmployees.delete(id); chip.classList.remove('active'); }
    else { mtSelectedEmployees.add(id); chip.classList.add('active'); }
    renderMtEmployeePicker();
  });
  document.getElementById('mt-select-all').addEventListener('click', function(){
    var allIds = Object.keys(employees);
    var allSelected = allIds.length > 0 && allIds.every(function(id){ return mtSelectedEmployees.has(id); });
    if (allSelected){ mtSelectedEmployees.clear(); } else { allIds.forEach(function(id){ mtSelectedEmployees.add(id); }); }
    renderMtEmployeePicker();
  });

  function closeSheetMt(){ sheetMt.classList.remove('open'); sheetMtBackdrop.classList.remove('open'); }

  // prefill : si fourni (tâche existante), prépare le formulaire pour une
  // DUPLICATION — "Dupliquer" crée toujours une nouvelle tâche, jamais une
  // modification de l'originale.
  function openMtSheet(prefill){
    document.getElementById('mt-title').value = prefill ? (prefill.title + ' (copie)') : '';
    document.getElementById('mt-time').value = prefill ? prefill.time : '09:00';
    var isDays = prefill && prefill.recurrence && prefill.recurrence.type === 'days';
    mtSelectedDays = new Set(isDays ? prefill.recurrence.days : []);
    mtSelectedEmployees = new Set(prefill ? Array.from(assignees[prefill.id] || []) : []);
    document.querySelectorAll('#mt-day-picker .day-chip').forEach(function(c){
      c.classList.toggle('active', mtSelectedDays.has(+c.dataset.day));
    });
    setMtFreqMode(isDays ? 'days' : 'daily');
    renderMtEmployeePicker();
    sheetMt.classList.add('open'); sheetMtBackdrop.classList.add('open');
  }
  document.getElementById('admin-add-task').addEventListener('click', function(){ openMtSheet(null); });
  document.getElementById('mt-cancel').addEventListener('click', closeSheetMt);
  sheetMtBackdrop.addEventListener('click', closeSheetMt);

  document.getElementById('mt-save').addEventListener('click', async function(){
    var title = document.getElementById('mt-title').value.trim();
    var time = document.getElementById('mt-time').value || '09:00';
    if (!title){ toast('Donne un nom à la tâche.'); return; }
    if (mtSelectedEmployees.size === 0){ toast('Choisis au moins un employé.'); return; }
    var recurrence;
    if (mtFreqMode === 'days'){
      if (mtSelectedDays.size === 0){ toast('Choisis au moins un jour.'); return; }
      recurrence = { type:'days', days: Array.from(mtSelectedDays) };
    } else { recurrence = { type:'daily' }; }

    var res = await sb.from('tasks').insert({
      title: title, time: time,
      recurrence_type: recurrence.type,
      recurrence_days: recurrence.type === 'days' ? recurrence.days : [],
      owner_employee_id: null,
      is_mandatory: true
    }).select();
    if (res.error || !res.data || !res.data[0]){ toast('Création impossible.'); return; }
    var row = res.data[0];
    tasks[row.id] = rowToTask(row);

    var assigneeRows = Array.from(mtSelectedEmployees).map(function(empId){ return { task_id: row.id, employee_id: empId }; });
    var res2 = await sb.from('task_assignees').insert(assigneeRows);
    if (res2.error){ toast('Tâche créée, mais erreur sur les destinataires.'); }
    else { toast('Tâche obligatoire créée.'); }

    assignees[row.id] = new Set(Array.from(mtSelectedEmployees));
    renderAll();
    renderAdminTasks();
    closeSheetMt();
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

    loadEmployees().then(function(){
      var saved = getSavedSession();
      if (saved && employees[saved.id]){
        session = saved;
        enterApp();
      } else {
        clearSession();
        renderLoginNames();
        splashMarkReady();
      }
    }).catch(function(){
      renderLoginNames();
      splashMarkReady();
    });
  }

  boot();
})();
