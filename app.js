(function(){
  "use strict";

  var CFG = window.FRIMOR_CONFIG || {};
  var CONFIGURED = CFG.SUPABASE_URL && CFG.SUPABASE_URL.indexOf('xxxx') === -1
                 && CFG.SUPABASE_ANON_KEY && CFG.SUPABASE_ANON_KEY.indexOf('colle-ici') === -1;
  var ONESIGNAL_CONFIGURED = CFG.ONESIGNAL_APP_ID && CFG.ONESIGNAL_APP_ID.indexOf('colle-ici') === -1;

  // Mode "annexe tablette" : activé par tablette.html (window.FRIMOR_TABLET_MODE = true
  // avant le chargement de ce fichier). Sur ce mode, tout le monde (y compris les
  // administrateurs) n'a que les onglets Tâches + Suivi, et l'onglet Suivi affiche
  // le tableau de bord "qui a fait quoi aujourd'hui" (habituellement réservé à Gestion)
  // au lieu du suivi d'habitudes personnel. Reste strictement false sur index.html.
  var TABLET_MODE = !!window.FRIMOR_TABLET_MODE;

  var sb = null;
  if (CONFIGURED && window.supabase){
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  }

  var session = null;        // {id, name, is_admin}
  var employees = {};        // id -> {id,name,is_admin}
  var assignees = {};        // taskId -> Set(employeeId), pour les tâches obligatoires
  var loginSelectedId = null;
  var viewAsId = null;       // id de l'employé consulté par le patron (lecture seule), ou null = vue de soi-même

  // Sur la tablette (partagée entre tout le monde dans l'entrepôt), on déconnecte
  // automatiquement le profil 5 minutes après la connexion, pour ne jamais
  // laisser le profil de quelqu'un ouvert pour la personne suivante. N'a
  // aucun effet sur l'appli téléphone/ordinateur (TABLET_MODE y est faux).
  var TABLET_AUTO_LOGOUT_MS = 5 * 60 * 1000;
  var tabletLogoutTimer = null;
  function scheduleTabletAutoLogout(){
    if (!TABLET_MODE) return;
    clearTimeout(tabletLogoutTimer);
    tabletLogoutTimer = setTimeout(function(){
      clearSession();
      location.reload();
    }, TABLET_AUTO_LOGOUT_MS);
  }

  function viewingEmployeeId(){ return viewAsId || (session && session.id); }
  function isReadOnlyView(){ return !!viewAsId; }

  var tasks = {};   // id -> {id,title,time,createdAt,example,recurrence:{type,days},ownerEmployeeId,isMandatory}
  var logs = {};    // "date_taskId_employeeId" -> {date,taskId,done,note,blocked}
  var todayLogsAll = {}; // pour le tableau de bord patron : "date_taskId_employeeId" -> done, pour TOUS les employés, jour courant
  var dashExpanded = {}; // id employé -> true si sa ligne est "dépliée" dans le tableau de bord (Suivi / Gestion)
  var dueSoon = new Set();
  var overdue = new Set();
  var notifiedKeys = new Set();

  // Changements (coché / note / empêchement) pas encore envoyés au serveur,
  // typiquement parce que la connexion a coupé (ex. chambre froide). On les
  // garde ici ET dans localStorage, pour les ré-essayer automatiquement dès
  // que la connexion revient — sans jamais perdre l'action de l'employé.
  // Clé = "date_taskId_employeeId" (même clé que logs), valeur = l'opération
  // à rejouer : { kind:'upsert', payload } ou { kind:'delete' }.
  function loadPendingSync(){ try{ var raw = localStorage.getItem('frimor_pending_sync'); return raw ? JSON.parse(raw) : {}; }catch(e){ return {}; } }
  function savePendingSync(){ try{ localStorage.setItem('frimor_pending_sync', JSON.stringify(pendingSync)); }catch(e){} }
  var pendingSync = loadPendingSync();
  var flushingSync = false;
  var flushSoonTimer = null;

  var DAY_NAMES = {0:'DIM',1:'LUN',2:'MAR',3:'MER',4:'JEU',5:'VEN',6:'SAM'};
  var REMINDER_LEAD_MIN = 20;
  var FREQ_DATE_HINTS = {
    date: "Cette tâche n'aura lieu qu'à cette date, une seule fois.",
    monthly: "Cette tâche reviendra chaque mois, le même jour du mois.",
    quarterly: "Cette tâche reviendra tous les 3 mois, le même jour du mois.",
    annual: "Cette tâche reviendra chaque année, à la même date."
  };

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
  function fmtDateShort(ds){ var d = dateFromKey(ds); return pad(d.getDate())+'/'+pad(d.getMonth()+1)+'/'+d.getFullYear(); }
  function fmtDateShortNoYear(ds){ var d = dateFromKey(ds); return pad(d.getDate())+'/'+pad(d.getMonth()+1); }
  function dayOfMonthLabel(ds){ return dateFromKey(ds).getDate(); }
  function daysInMonth(y, m){ return new Date(y, m+1, 0).getDate(); } // m : 0-indexé
  // Vérifie si `d` tombe sur le même jour-du-mois que `anchor`, tous les
  // `everyNMonths` mois à partir de `anchor` (mensuel=1, trimestriel=3,
  // annuel=12). Si le mois de `d` a moins de jours que le jour d'ancrage
  // (ex. ancrage le 31, mois de 30 jours), on retombe sur le dernier jour du
  // mois — pour ne jamais "sauter" un mois silencieusement.
  function matchesPeriodic(anchor, d, everyNMonths){
    var a0 = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
    var d0 = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    if (d0 < a0) return false;
    var diffMonths = (d0.getFullYear()-a0.getFullYear())*12 + (d0.getMonth()-a0.getMonth());
    if (diffMonths < 0 || diffMonths % everyNMonths !== 0) return false;
    var lastDay = daysInMonth(d0.getFullYear(), d0.getMonth());
    var targetDay = Math.min(a0.getDate(), lastDay);
    return d0.getDate() === targetDay;
  }
  function isScheduled(task, date){
    var rec =
