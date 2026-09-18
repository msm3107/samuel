## Handoff

### Summary

Fixed the Major and minor defects the Codex review of PR #6 found in
already-merged sign-in code: F1, F2, F3, F6, F7, F9 and F10. Each fix has a
test that fails without it.

Branch `feat/sign-in-hardening`, stacked on `feat/local-supabase-e2e` (PR #6).

Handled elsewhere, not in this task:

- **F4** (TASK-003c's lockout design): the TASK-003c contract was amended on
  PR #6.
- **F5** (reviewer rules changed inside the PR they govern): moved to PR #7,
  with an explicit owner-acceptance rule.
- **F8, F11, F12:** see Remaining concerns.

### Fixes

- **F1: a second sign-in broke the first link.** Every flow shared one PKCE
  verifier slot. A second request, or one GoTrue rejected (auth-js then
  deletes the verifier), destroyed the verifier a pending link needed. Both
  session clients now enable auth-js's `appendPkceFlowIdToRedirects`, so each
  flow has its own slot and its id travels in the redirect (`sb_flow_id`).
  - **Partly fixed.** The same-address retry the review described is not
    fixed by flow ids. In CI on PR #8, the first link after a second request
    reached the callback with flow 1's id, found flow 1's verifier, and GoTrue
    answered `bad_code_verifier`. GoTrue appears to bind the emailed link to
    the newest flow state for the address even when it sends no second email
    (inferred from that error). The fix is the app's 60-second per-address
    spacing in TASK-003c, which never forwards the second request; that
    regression test moved to TASK-003c's contract.
  - What flow ids do fix, and test: a Google sign-in started and abandoned
    while a magic link is pending no longer breaks that link.
  - The callback already passed `sb_flow_id` through.
  - `config.toml` adds a `?sb_flow_id=*` entry beside each callback URL.
  - The option lives in `PKCE_FLOW_OPTIONS` in
    `lib/database/session-cookie-options.ts`.
- **F2: anonymous sign-outs.** After a non-retryable refresh failure,
  including a 429, auth-js deletes the session. The proxy forwarded that
  deletion, so exhausting the auth server's per-IP refresh limit would sign
  other people out.
  - `applySessionCookies(response, { keepExistingSession })` now drops
    removals whenever the session is unverifiable.
  - Refreshed tokens are still written, because a rotated refresh token must
    reach the browser.
  - The per-network refresh limit itself is in the amended TASK-003c.
- **F3: no way to sign out.** The dashboard layout has a header with a
  sign-out form. It posts a server action, so Next.js checks the origin; it is
  never a link.
- **F6:** a real-Supabase test signs out through the application and has the
  old cookies rejected.
- **F7: the proxy skipped security headers for any path starting with
  "widget".** It now excludes only `/widget`, `/widget/…` and `/widget.js`,
  checked with Next's own matcher evaluator.
- **F9: no error pages.** `app/error.tsx` and `app/global-error.tsx` show
  Next's error digest as a reference and never the error's message.
- **F10: plain http allowed in production.** In production,
  `SUPABASE_URL` and `NEXT_PUBLIC_APP_URL` must be https, except loopback
  hosts, which the local production-build suites use.

### Tests, each proven to fail without its fix

| Finding | Where                                                             | Without the fix               |
| ------- | ----------------------------------------------------------------- | ----------------------------- |
| F1      | `tests/supabase/auth/sign-in.supabase.ts`: Google abandoned, link | runs in CI (Docker down here) |
| F2      | `tests/security/auth/expired-session.test.ts`: 429, 408, 409      | 3 tests fail                  |
| F3      | `tests/e2e/auth/sign-in.spec.ts`: keyboard sign-out; integration  | no sign-out control           |
| F6      | `tests/supabase/auth/sign-in.supabase.ts`: app sign-out, replay   | runs in CI (Docker down here) |
| F7      | `tests/security/headers/proxy-matcher.test.ts`, 17 cases          | 6 fail with the old matcher   |
| F9      | `tests/security/errors/error-pages.test.ts`, 6 cases              | pages did not exist           |
| F10     | `tests/unit/env/server-env.test.ts`, 7 cases                      | http accepted in production   |

Tests that asserted the old redirect shape now require the flow id: the
callback's origin and path, plus exactly one `sb_flow_id` of 32 hex
characters. The integration tests follow the redirect the app asked for,
flow id included, as a real link does.

### Commands run

- `pnpm typecheck`, `pnpm lint`: passed
- `pnpm format:check`: passes for every file on this branch. It fails only on
  the untracked `CODEX-SECURITY.md`, which is the project owner's.
- `pnpm test`: 417 passed
- `pnpm test:integration`: 26 passed
- `pnpm test:security`: 239 passed
- `pnpm test:e2e`: 14 passed, including sign-out

**Not run locally:** `pnpm test:supabase` and `pnpm test:e2e:supabase`. Docker
Desktop 4.91.0 crashes on a stale `sailor-ingest.sock`, and a factory reset
turned Docker AI back on. The PR's `End-to-end` job runs both, including the
new F1 and F6 tests.

### Remaining concerns

- **Session lifetime is undecided.** There is no absolute or idle limit, and
  the cookie lasts 400 days. The project owner decides the GoTrue
  `sessions.timebox` and `sessions.inactivity_timeout` values, and a cookie
  maximum age to match. Until then, sign-out is how a session ends.
- **Production must match.** The hosted project's redirect allowlist needs the
  same `?sb_flow_id=*` entry beside its callback URL, or production sign-in
  links will fall back to `site_url`.
- **F8:** the audit gate fails only on high severity. The vitest 4 upgrade is
  already a separate follow-up.
- **F11:** log redaction covers fixed field names; deeper redaction and a test
  are a follow-up.
- **F12:** the repository layout and stale branches (`masterofpuppas-g`,
  `super-nowa`) are the project owner's to clean up.
