## Handoff

### Summary

Built the `/sign-in` screen: a magic-link form and a Google button. The screen
calls the TASK-003a server actions and renders the result codes they return; it
decides nothing. Added Playwright as the first end-to-end suite.

Branch `feat/sign-in-screen`, stacked on `feat/sign-in-server-flow` (TASK-003a,
PR #4), itself stacked on #3 and #2. None are merged yet.

Three reviewers ran in parallel: security, contract, and accessibility.

- **Security:** `APPROVE WITH NON-BLOCKING NOTES`.
- **Accessibility:** `REJECT`, one blocking finding. Fixed.
- **Contract:** `REJECT`, three blocking findings. All fixed or recorded.

The first attempt at this review hit a session limit before any reviewer
reported, and was re-run.

### Blocking findings, and the fixes

1. **Keyboard focus was lost while a link was being sent** (accessibility).
   `disabled` on the focused button threw focus to `<body>`, and nothing
   announced the request was in flight. The button now uses `aria-disabled`,
   a submit guard refuses a second submission, and the live region announces
   "Sending sign-in link…". A Playwright test holds the action open and asserts
   the button keeps focus and only one request is sent. Changing back to
   `disabled` fails it, and so does removing the guard.
2. **No handoff** (contract). This file.
3. **Out-of-scope changes without an amendment** (contract). The e2e support
   code moved into `tests/e2e/auth/support/`, inside scope, and the
   `eslint.config.mjs` change was reverted in favour of a single justified
   inline disable in `playwright.config.ts`. Both are recorded in the contract.
4. **TASK-003b didn't close the real-Supabase gap it was handed** (contract).
   The draft now includes pointing this Playwright suite at real local
   Supabase, reading the magic link from Mailpit, and running `pnpm test:e2e`
   in its CI workflow.

### Non-blocking findings addressed

- `aria-invalid` was set on a valid address during an outage; now only for
  `invalid_email`.
- The typed address was erased after each submission (React resets
  uncontrolled forms after an action); the input is now controlled.
- An identical repeated message wasn't re-announced, and a stale message
  stayed visible during a new request; the live region now changes to progress
  text while pending.
- The page had no descriptive title; it is now "Sign in · Article50.js".
- The input border was 1.48:1 against white; raised to `slate-500` (about
  4.8:1, above the 3:1 non-text minimum).
- A callback error stayed on screen after a new link was requested; it now
  clears when a new attempt starts.
- A repeated `?error=` showed nothing; it now shows the generic message.
- `pnpm test:e2e` failed in a clean shell because the build needed server
  configuration; it now builds with the same placeholder environment it runs
  with.
- The e2e app inherited the whole shell environment (a developer's real
  `SENTRY_DSN` would have reached it) and listened on all interfaces. It now
  inherits only what Node needs and binds to localhost.
- The launcher carried on if the stub couldn't bind its port, so tests could
  run against a foreign server. It now waits for the stub's health check and
  exits if the stub dies.
- The stub's single-use auth code was spent for the life of the server, so a CI
  retry was guaranteed to fail. It is now single-use per flow (per verifier);
  `--repeat-each 2` passes 26 of 26.
- The stub-based enumeration test is now labelled as proving the screen's copy
  only.

### Files changed

- app/(auth)/sign-in/page.tsx (new)
- app/(auth)/sign-in/sign-in-messages.ts (new)
- components/forms/magic-link-form.tsx (new)
- components/forms/google-sign-in-form.tsx (new)
- tests/unit/sign-in/sign-in-messages.test.ts (new)
- tests/e2e/auth/sign-in.spec.ts (new)
- tests/e2e/auth/support/: stub-auth-server.mjs, start-e2e-app.mjs,
  build-e2e-app.mjs, e2e-env.mjs (new)
- playwright.config.ts (new)
- package.json, pnpm-lock.yaml (`@playwright/test` 1.63.0 pinned; `test:e2e`,
  `test:e2e:ui` scripts)
- .ai/tasks/TASK-003-sign-in.md, TASK-003b-\*.md (amended), this handoff

### Dependency: `@playwright/test` 1.63.0 (`README.md` §56)

- **Problem:** browser-level tests for the sign-in flow. The contract requires
  e2e tests, and `AGENTS.md` §2 schedules Playwright to arrive with the first
  user-facing flow, which this is.
- **Platform alternative:** none that drives a real browser. Vitest cannot
  exercise hydration, focus, CSP nonces on rendered scripts, or cookies across
  a redirect.
- **Maintenance:** Microsoft, Apache-2.0; registry last modified 2026-09-17.
- **Runs in the browser:** no. It is a devDependency and never enters the
  application bundle.
- **Permissions:** it downloads browser binaries on
  `playwright install` (about 700 MB under `%LOCALAPPDATA%\ms-playwright`) and
  launches local processes during tests.
- **Security history:** no advisory affecting this version found at install
  time; it stays under `pnpm audit` in CI.
- **Bundle size:** none.

### Security considerations

- The screen renders only copy chosen from result codes. `?error=` is mapped
  through a fixed table; unknown, hostile, or repeated values show the generic
  message and are never rendered. (The raw value does appear inside Next's
  escaped RSC payload, which the security review judged not exploitable.)
- Messages are identical for registered and unregistered addresses.
- Both forms are server actions, so Next.js enforces its origin check.
- No server-only value crosses into the client component; it receives only an
  already-mapped message string.
- CSP: every script tag on the rendered page carries the response nonce,
  asserted in a real browser through the DOM `nonce` property.

### Tests

- **Unit** (`tests/unit/sign-in/`): 12 tests. One message for every address;
  no wording that reveals whether an account exists; a distinct message per
  callback code; hostile and unknown values get the generic message.
- **End to end** (`tests/e2e/auth/sign-in.spec.ts`): 13 tests in Chromium
  against a production build:
  - requesting a link shows the confirmation
  - the whole form works by keyboard alone
  - known and unknown addresses get the same answer (screen copy only)
  - a full sign-in through `/auth/callback` reaches the dashboard
  - a signed-out visitor to `/dashboard` lands on `/sign-in`
  - a link opened in another browser explains the same-browser rule
  - an unrecognised or repeated `?error=` shows the generic message
  - every script tag carries the response nonce
  - focus stays on the button and only one request is sent while pending
  - the typed address survives a request
  - a callback error clears when a new link is requested
  - the page title

### Manual verification: Google OAuth

Not testable locally without Google credentials, and TASK-003b keeps the
provider disabled unless they are supplied. To verify once they exist:

1. Create an OAuth client in Google Cloud Console with authorized redirect URI
   `<SUPABASE_URL>/auth/v1/callback`.
2. Enable the Google provider in Supabase (local `config.toml` via `env()`, or
   the hosted dashboard) with that client id and secret, and add
   `<NEXT_PUBLIC_APP_URL>/auth/callback` to the redirect allowlist.
3. With JavaScript enabled, open `/sign-in` and choose "Continue with Google".
   Expect Google's consent screen, then `/dashboard`.
4. Check the session cookie in DevTools: `sb-<ref>-auth-token` is `HttpOnly`
   and, outside development, `Secure`.
5. Cancel on Google's consent screen. Expect `/sign-in` with "Sign-in did not
   complete".
6. Known limitation: with JavaScript disabled, the Google button does nothing
   visible, because `form-action 'self'` blocks the redirect to the Supabase
   origin. The magic link works without JavaScript.

### Commands run

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`: passed
- `pnpm test`: passed, 19 files, 378 tests
- `pnpm test:e2e` from a shell with no application variables set: built, then
  13 of 13 passed
- `pnpm exec playwright test --repeat-each 2`: 26 of 26 passed
- Mutation checks, each rebuilt and run: reverting to `disabled` fails the
  focus test; removing the repeat-submit guard fails it too

Not run: anything against real Supabase, or Google OAuth (see above).

### Remaining concerns

- **Not proven against real Supabase.** The magic-link flow is proven against
  a stub that cannot distinguish addresses or model GoTrue's timing. TASK-003b,
  still an unapproved draft, owns this.
- **Double-submit is guarded only after hydration.** Before the client bundle
  loads, or without JavaScript, each click is a native POST and requests another
  link. Supabase's per-address email throttle (configured in TASK-003b) is the
  real limit; the app has none of its own yet.
- **No application rate limit on the magic-link action.** A script can call it
  in a loop with many addresses and exhaust the project-wide email limit,
  after which every visitor sees a false "Check your email". Tracked for the
  Phase 6 rate limiter, which Phase 1 adopts retroactively; worth a CAPTCHA
  before launch.
- **Possible enumeration outside the screen's control.** Supabase's default
  SMTP rejects addresses outside the team with `email_address_not_authorized`,
  which TASK-003a maps to `unavailable` — a different answer for some
  addresses. Unverified against a real instance; a TASK-003a follow-up.
- **Google sign-in requires JavaScript** (the CSP `form-action` limitation
  above). Widening `form-action` is a decision for the project owner, and
  touches `proxy.ts`.
- **Playwright is not in CI yet.** It runs locally only, until TASK-003b's
  workflow lands.
