# TASK-003c — Application rate limiting for sign-in

## Objective

Enforce the application's own rate limits on every sign-in entry point, checked
before any call to Supabase Auth, so an attacker cannot use this application to
mail-bomb third-party inboxes or exhaust the project's Supabase Auth limits and
lock everyone out.

This lands the Phase 6 shared primitive (`lib/security/rate-limit.ts`) early.
Phase 6 and Phase 10 reuse it rather than writing a second limiter.

## Owner agent

Database (migration) then Backend (limiter and wiring).

## Dependencies

TASK-003a (sign-in server flow) and TASK-003b (local Supabase, to run the
migration and the real-database tests).

## Decisions already made (project owner, 2026-09-17)

- Counters live in a Postgres table in this project's own Supabase database,
  shared by every server instance. The check is a database call, never a
  Supabase Auth call.
- Client IP is trusted only from Vercel's platform headers, and only when
  running on Vercel. Elsewhere (local, e2e) every request shares one fixed IP
  key, so our own header parsing can never be spoofed into a fresh bucket.

## Allowed files

- supabase/migrations/<timestamp>\_rate_limits.sql
- lib/security/rate-limit.ts, lib/security/client-ip.ts,
  lib/security/turnstile.ts
- lib/env/server-env.ts (add `RATE_LIMIT_HMAC_SECRET`, `TURNSTILE_SITE_KEY`,
  `TURNSTILE_SECRET_KEY`, and read `VERCEL`)
- .env.example (the new variables, empty)
- lib/auth/sign-in/\*\* (wire the limiter in; new result codes)
- app/(auth)/sign-in/\*\* (copy for the new codes; pass the site key)
- app/(auth)/auth/callback/route.ts (the callback limit)
- components/forms/magic-link-form.tsx, components/forms/turnstile-widget.tsx
- proxy.ts (the sign-in page's `frame-src` only)
- README.md (the privacy notice, §34)
- playwright.config.ts, playwright.supabase.config.ts (a project for the
  challenge spec, which runs after the others; added 2026-09-19)
- scripts/local-env.mjs, tests/e2e/auth/support/\*\* (local and e2e values
  for the new variables; the stub answers the limiter's database call)
- .github/workflows/ci.yml, .github/workflows/e2e.yml (placeholder values for
  the new variables only)
- tests/unit/security/\*\*, tests/security/rate-limit/\*\*,
  tests/supabase/rate-limit/\*\* (`*.supabase.ts`)
- tests/security/auth/\*\*, tests/integration/auth/\*\*,
  tests/unit/sign-in/\*\*, tests/unit/auth/\*\*, tests/unit/env/\*\*,
  tests/setup-test-env.ts, tests/security/headers/\*\*,
  tests/e2e/auth/\*\*, tests/supabase/auth/\*\* (update for the new behaviour)

## Forbidden files

- lib/database/\*\* (the limiter uses the existing service-role factory)
- proxy.ts beyond the sign-in page's `frame-src`: the refresh limit is
  TASK-003f
- security.yml

## Invariants

- **Checked first.** In every limited path, the limit is consumed before any
  call to Supabase Auth. A limited request makes zero Auth requests.
- **Atomic.** One SQL function consumes a token and reports the outcome in a
  single statement (`insert … on conflict … do update … returning`). Two
  concurrent requests can never both take the last slot.
- **Locked table.** The `rate_limits` table has RLS enabled and no policies.
  The function is `security definer` with a pinned `search_path`, and
  `execute` is revoked from `public`, `anon` and `authenticated` and granted
  only to `service_role`. The anon key cannot read, write, or exhaust a bucket.
  This is a legitimate service-role use: no session can do it by design.
- **No personal data at rest.** Buckets are keyed by
  `HMAC-SHA256(RATE_LIMIT_HMAC_SECRET, "<scope>:<value>")`. The table never
  holds an email address or IP. The secret is at least 32 characters and
  validated in `lib/env`.
- **Fails closed.** If the limiter cannot be consulted, the request is refused
  as `unavailable` and Supabase Auth is not called.
- **No enumeration.** A per-address limit answers exactly as a successful
  request does (`link_sent`), because a link was already sent. Only per-IP and
  global limits answer `rate_limited`, which says nothing about any address.
- **Limits before the response floor.** The magic-link action holds every
  answer to a fixed floor (TASK-003b), which also holds connections for any
  request an attacker sends. Per-IP and global limits are checked first, and a
  rejection that reveals nothing about any account (rate-limited, malformed
  body) answers without the floor. Anything that reaches Supabase Auth keeps
  it.
- **Expired rows are bounded.** Each bucket row holds one window; the function
  resets an expired window in place, so the table grows only with distinct keys,
  and a cleanup deletes rows older than a day.

## Limits (defaults, in one reviewed constant)

| Scope                | Key                | Limit                                          |
| -------------------- | ------------------ | ---------------------------------------------- |
| Magic link           | client network     | 5 per 10 minutes                               |
| Magic link           | normalized address | 3 per 10 minutes, and at least 60 s apart      |
| Magic link           | global             | 200 per hour, then a CAPTCHA challenge + alert |
| Google sign-in start | client network     | 10 per 10 minutes                              |
| Callback exchange    | client network     | 20 per 10 minutes                              |
| Session refresh      | client network     | 30 per 5 minutes (proxy, see below)            |

"Client network" is the IPv4 address, or the IPv6 /64 prefix: one host can
own a whole /64, so keying on the full IPv6 address gives an attacker 2^64
fresh buckets.

## Amendment after Codex review of PR #6 (2026-09-18)

- **No hard global refusal.** A hard global cap lets a few addresses, or one
  IPv6 /64, block every sign-in. Past the global threshold the magic-link form
  requires a CAPTCHA (GoTrue verifies it natively), and an alert fires. Which
  provider is a decision for the project owner (see below).
- **Per-address spacing matches GoTrue.** Requests for one address at least
  60 s apart, the same as `auth.email.max_frequency`, so the app never forwards
  a request GoTrue would reject. A rejected request makes auth-js delete the
  pending PKCE verifier, which breaks the link already sent (review finding F1).
- **Session refreshes are limited too.** Every expired session triggers a
  server-side refresh from the application's own IP, and GoTrue's refresh
  limit counts per IP, so anonymous junk cookies could exhaust it for every
  user (F2). The proxy decodes the cookie's `expires_at` locally; when a
  refresh would be needed, it consumes a per-network refresh token first, and
  past the limit it treats the session as unverifiable without calling GoTrue
  and without deleting any cookie.
- **Cleanup is named.** A `pg_cron` job created in the same migration deletes
  rows whose window ended more than a day ago. Keys are HMACs of client
  networks and normalized addresses, so the table's growth is bounded by those
  distinct values within a day.
- **Decision required before starting:** the CAPTCHA provider (Cloudflare
  Turnstile or hCaptcha). It affects the CSP (`script-src`, `frame-src`), the
  privacy notice (`README.md` §34), and a new secret.

## Amendment: Turnstile, and the refresh limit split out (2026-09-18)

The project owner chose **Cloudflare Turnstile**.

- **The application verifies the token, not GoTrue.** GoTrue's own CAPTCHA
  check is all or nothing: once enabled, every magic-link request needs a
  token. The approved design asks for a challenge only past the global
  threshold, so the app calls Cloudflare's `siteverify` itself and GoTrue's
  CAPTCHA stays off. This is safe because the anon key is server-only here
  (there is no browser client), so GoTrue cannot be called around the
  application. Cloudflare's script loads only while the threshold is
  exceeded, never on an ordinary visit.
- **Verification fails closed.** `siteverify` gets a 5-second timeout. A
  timeout, a network error or an unreadable answer is `unavailable`, and
  Supabase Auth is not called. The token is at most 2048 characters and
  checked with Zod before it is sent. Cloudflare refuses a replayed token.
- **The answer is checked, not only `success`.** With a real secret, the
  hostname must be the application's and the action `magic_link`, and an
  answer flagged `result_with_testing_key` is refused. With one of
  Cloudflare's test secrets, siteverify answers hostname `example.com`, no
  action, and that flag (observed 2026-09-19; Cloudflare's docs say
  `localhost` and `test`), so only the flag is checked.
- **Test keys stay out of production.** In production, Cloudflare's published
  test keys are refused unless the application URL is loopback (the local
  production-build suites), the same exception as https.
- **Check order for a magic link:**
  1. Malformed body: `invalid_email`, without the floor.
  2. Per-network limit: `rate_limited`, without the floor.
  3. Global threshold: past it, a missing token is `captcha_required` and a
     rejected one `captcha_failed`, both without the floor.
  4. Inside the response floor: the per-address limit (answers `link_sent`
     without calling GoTrue), then Supabase Auth.
- **CSP.** Only the sign-in page gets
  `frame-src https://challenges.cloudflare.com`. The widget's script is
  inserted by the application's own nonce-trusted code, which
  `'strict-dynamic'` allows, so `script-src` gains no host.
- **Residual risk, recorded.** Someone who knows an address can spend its
  per-address allowance (3 links per 10 minutes, each a real email to that
  address) and so hold back that person's magic links for up to 10 minutes.
  Google sign-in stays available. Per-address limit hits are logged, without
  the address, for alerting in Phase 12. Accepted by msm3107 (project owner),
  2026-09-19.
- **Residual risk, recorded (2026-09-19):** a per-address-limited request
  answers `link_sent` inside the same floor, but it starts no PKCE flow, so
  its response sets no verifier cookie where a sent link's does. Someone who
  requests a link for an address can therefore tell that a link was requested
  for it within the last few minutes. It says nothing about whether an account
  exists (unregistered addresses get links too). A convincing decoy cookie
  would have to rewrite auth-js's flow index, which can evict the slot of a
  link that is really pending: the very thing the per-address limit protects
  (review finding F1). Accepted by msm3107 (project owner), 2026-09-19.
- **The session-refresh limit moves to TASK-003f.** It changes the proxy and
  is reviewed separately. Its tests move with it.

## Acceptance criteria

- A request over any limit makes no Supabase Auth call.
- Exceeding the per-address limit returns `link_sent`; exceeding per-IP or
  global returns `rate_limited`.
- The migration applies cleanly with `supabase db reset`, and the anon and
  authenticated roles can neither call the function nor touch the table.
- Concurrent consumption never exceeds the limit (tested against real Postgres).
- No email address or IP appears in the database or the logs.
- Past the global threshold the form shows the Turnstile widget, and a valid
  token lets the request through; the CSP allows the widget only on
  `/sign-in`.
- Typecheck, lint, format, unit, security, e2e and `test:supabase` pass.

## Required tests

- unit: HMAC keying never includes the raw value; client-IP resolution trusts
  platform headers only on Vercel
- security: limited requests make zero Auth calls; per-address limit is
  indistinguishable from success; limiter failure fails closed
- security: addresses within one IPv6 /64 share a bucket; past the global
  threshold the form demands a CAPTCHA rather than refusing everyone
- security: `siteverify` failure, timeout, wrong hostname, wrong action or an
  oversized token never reaches Supabase Auth; test keys are refused in
  production off loopback
- e2e: with the global threshold forced, the widget appears (Cloudflare's
  always-pass test key) and the request completes
- supabase: two magic-link requests for one address within 60 s, then the
  first link signs in. Real GoTrue binds the emailed link to the newest flow
  state even when it does not send a second email, so the second request made
  the only link fail with `bad_code_verifier` (observed in CI on PR #8). Only
  the app's per-address spacing, answering `link_sent` without calling
  GoTrue, prevents it.
- supabase: atomic consumption under concurrency; window reset; anon and
  authenticated cannot execute the function or read the table
