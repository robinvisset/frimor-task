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
        + '<div
