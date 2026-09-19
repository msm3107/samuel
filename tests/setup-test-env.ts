/**
 * A valid baseline configuration for tests. Individual tests that exercise
 * rejection paths pass their own source object to the parser instead of
 * mutating this, so test order never changes behavior.
 */
const TEST_ENV: Readonly<Record<string, string>> = {
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  STRIPE_SECRET_KEY: "sk_test_placeholder",
  STRIPE_WEBHOOK_SECRET: "whsec_test_placeholder",
  CRON_SECRET: "test-cron-secret-value-that-is-long-enough",
  RATE_LIMIT_HMAC_SECRET: "test-rate-limit-secret-long-enough-for-hmac",
  // Cloudflare's always-pass test keys.
  TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
  TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
  LOG_LEVEL: "error",
};

for (const [name, value] of Object.entries(TEST_ENV)) {
  process.env[name] ??= value;
}
