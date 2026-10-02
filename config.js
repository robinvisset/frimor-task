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
  SUPABASE_URL: "https://xxxxxxxxxxxx.supabase.co",
  SUPABASE_ANON_KEY: "colle-ici-ta-cle-anon-public",

  // Dans OneSignal : Settings → Keys & IDs
  ONESIGNAL_APP_ID: "colle-ici-ton-app-id-onesignal"
};
