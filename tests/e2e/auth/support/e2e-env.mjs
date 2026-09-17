// The environment the end-to-end app is built and started with.
//
// Only what Node needs to run is inherited from the shell; everything the
// application reads is set here to a placeholder. A developer's real
// SENTRY_DSN or Stripe price ids therefore never reach an e2e run. Next.js
// still reads `.env.local` for variables left unset, which is why every
// variable the application's schema knows is set explicitly below.

const INHERITED = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "ComSpec",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "CI",
];

export function e2eEnv(appPort) {
  const inherited = Object.fromEntries(
    INHERITED.filter((name) => process.env[name] !== undefined).map((name) => [
      name,
      process.env[name],
    ]),
  );

  return {
    ...inherited,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_APP_URL: `http://localhost:${appPort}`,
    SUPABASE_URL: `http://127.0.0.1:${appPort + 1}`,
    // Placeholders: the stub validates nothing and no real service is reached.
    // Never replace these with live credentials.
    SUPABASE_ANON_KEY: "e2e-placeholder-anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "e2e-placeholder-service-role-key",
    STRIPE_SECRET_KEY: "sk_test_e2e_placeholder",
    STRIPE_WEBHOOK_SECRET: "whsec_e2e_placeholder",
    STRIPE_PRICE_FOUNDER: "price_e2e_placeholder",
    STRIPE_PRICE_AGENCY: "price_e2e_placeholder",
    STRIPE_PRICE_AGENCY_PRO: "price_e2e_placeholder",
    CRON_SECRET: "e2e-placeholder-cron-secret-of-sufficient-length",
    LOG_LEVEL: "warn",
  };
}

export const E2E_APP_PORT = 3210;
