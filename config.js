// ============================================================
// Réglages publics de l'application — à remplir une seule fois.
// Ces valeurs sont visibles par n'importe qui ouvre l'appli
// (c'est normal et voulu, elles sont faites pour ça).
// Les clés SECRÈTES (Supabase service role, OneSignal REST API key)
// ne vont jamais ici : elles vont dans les variables d'environnement
// Vercel, utilisées uniquement par api/schedule-notifications.js.
// ============================================================

window.FRIMOR_CONFIG = {
  // Dans Supabase : Project Settings → API
  SUPABASE_URL: "https://jdoedspfkmpjexvbnqlc.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_fxalkHtssqFXBJPol-qSjw_QUmDiQHQ",

  // Dans OneSignal : Settings → Keys & IDs
  ONESIGNAL_APP_ID: "dcf91ee2-1d86-41a3-8ec9-da43ed5286ca"
};
