import { defineConfig, devices } from "@playwright/test";

import base from "./playwright.config";

/**
 * Browser specs against the real local Supabase instead of the stub: GoTrue
 * sends real mail to Mailpit and the specs follow the link a person would.
 * Only `*.supabase.spec.ts` files run here. They need a running instance
 * (`pnpm supabase:start`) and are started by `pnpm test:e2e:supabase`.
 *
 * Port 3220's callback is listed in `supabase/config.toml`'s redirect allowlist.
 */
const PORT = 3220;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  ...base,
  testMatch: "**/*.supabase.spec.ts",
  testIgnore: [],
  // Replaces the base projects: their own testMatch and testIgnore would win
  // over the two lines above, dropping this config's specs and running the
  // stub-only challenge spec instead.
  //
  // `session` signs in once and saves the session for the specs that share
  // it (TASK-015a); it runs first, every run. Only the specs that load it
  // are signed in: the rest, the sign-in spec's link tests included, start
  // from an empty browser.
  projects: [
    {
      name: "session",
      testMatch: "**/*.supabase.setup.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["session"],
    },
  ],
  // One mailbox, one auth server, and GoTrue's own rate limits: run in turn.
  fullyParallel: false,
  workers: 1,
  use: { ...base.use, baseURL: BASE_URL },
  webServer: {
    command: `node tests/e2e/auth/support/start-e2e-app.mjs ${PORT} --supabase`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
