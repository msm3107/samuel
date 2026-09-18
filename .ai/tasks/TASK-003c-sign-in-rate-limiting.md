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
- lib/security/rate-limit.ts, lib/security/client-ip.ts
- lib/env/server-env.ts (add `RATE_LIMIT_HMAC_SECRET`, and read `VERCEL`)
- .env.example (the new variable, empty)
- lib/auth/sign-in/\*\* (wire the limiter in; add a `rate_limited` result code)
- app/(auth)/sign-in/sign-in-messages.ts (copy for `rate_limited`)
- tests/unit/security/\*\*, tests/security/rate-limit/\*\*,
  tests/supabase/rate-limit/\*\* (`*.supabase.ts`)
- tests/security/auth/\*\*, tests/integration/auth/\*\*, tests/unit/sign-in/\*\*
  (update for the new code)

## Forbidden files

- lib/database/\*\* (the limiter uses the existing service-role factory)
- proxy.ts
- components/\*\*
- ci.yml, security.yml

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

| Scope                | Key                | Limit             |
| -------------------- | ------------------ | ----------------- |
| Magic link           | client IP          | 5 per 10 minutes  |
| Magic link           | normalized address | 3 per 10 minutes  |
| Magic link           | global             | 200 per hour      |
| Google sign-in start | client IP          | 10 per 10 minutes |
| Callback exchange    | client IP          | 20 per 10 minutes |

## Acceptance criteria

- A request over any limit makes no Supabase Auth call.
- Exceeding the per-address limit returns `link_sent`; exceeding per-IP or
  global returns `rate_limited`.
- The migration applies cleanly with `supabase db reset`, and the anon and
  authenticated roles can neither call the function nor touch the table.
- Concurrent consumption never exceeds the limit (tested against real Postgres).
- No email address or IP appears in the database or the logs.
- Typecheck, lint, format, unit, security and `test:supabase` pass.

## Required tests

- unit: HMAC keying never includes the raw value; client-IP resolution trusts
  platform headers only on Vercel
- security: limited requests make zero Auth calls; per-address limit is
  indistinguishable from success; limiter failure fails closed
- supabase: atomic consumption under concurrency; window reset; anon and
  authenticated cannot execute the function or read the table
