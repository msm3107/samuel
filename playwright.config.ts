import { defineConfig, devices } from "@playwright/test";

const PORT = 3210;

// Test-runner configuration, not application code: whether the run is in CI
// only decides retries and reporting, so lib/env is not the place for it.
// eslint-disable-next-line no-restricted-properties
const isCI = Boolean(process.env.CI);
const BASE_URL = `http://localhost:${PORT}`;

/**
 * End-to-end specs run against a production build, because the proxy's CSP
 * nonce and the dynamic rendering it depends on behave differently under the
 * development bundler.
 *
 * `SUPABASE_URL` points at the stub auth server started alongside the app
 * (`tests/e2e/auth/support/stub-auth-server.mjs`). Build with
 * `pnpm test:e2e`, which uses the same placeholder environment; a build made
 * with different configuration would test something else. The same suite
 * against real local Supabase runs from playwright.supabase.config.ts.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  // Real-Supabase specs run under playwright.supabase.config.ts instead.
  testIgnore: "**/*.supabase.spec.ts",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? "github" : "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      // Replaces the top-level testIgnore, so both patterns are listed.
      testIgnore: ["**/*.supabase.spec.ts", "**/*.challenge.spec.ts"],
    },
    {
      // Puts the stub past the global magic-link threshold, which would
      // change every other spec's answers, so it runs only after they finish.
      name: "challenge",
      use: { ...devices["Desktop Chrome"] },
      testMatch: "**/*.challenge.spec.ts",
      dependencies: ["chromium"],
    },
  ],
  webServer: {
    command: `node tests/e2e/auth/support/start-e2e-app.mjs ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
