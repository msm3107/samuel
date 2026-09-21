# TASK-003f — Per-network limit on session refreshes

## Objective

Stop anonymous junk cookies from exhausting the auth server's refresh limit
for everyone. Every expired session makes the proxy refresh it from this
application's IP, and GoTrue counts refreshes per IP (Codex review of PR #6,
finding F2). The proxy consumes a per-network refresh allowance before any
refresh reaches GoTrue.

Split out of TASK-003c on 2026-09-18, so the proxy change is reviewed on its
own.

## Owner agent

Backend

## Dependencies

TASK-003c (the limiter, `lib/security/rate-limit.ts`, and client-network
resolution, `lib/security/client-ip.ts`).

## Allowed files

- proxy.ts
- lib/auth/session-expiry.ts (reads the cookie's `expires_at` locally)
- lib/security/rate-limit.ts (the two new limits this task's amendment adds:
  `sessionRefreshGlobal` and its alert; added 2026-09-19, as TASK-003g did for
  its own entries)
- tests/unit/auth/\*\*, tests/security/auth/\*\*, tests/security/rate-limit/\*\*,
  tests/supabase/auth/\*\*

## Forbidden files

- lib/database/\*\*, supabase/migrations/\*\*

## Amendment (2026-09-19, from the review of PRs #9-#11)

- **A service-wide ceiling as well: 100 refreshes per 5 minutes.** GoTrue
  counts code exchanges, refreshes and password grants in one bucket per
  client IP (`limiterOpts.Token`, `internal/api/token.go`; 150 per 5 minutes
  by default), and every one of them comes from this application's servers.
  Per-network limits have no total, so many networks — IPv6 /64s are cheap —
  could spend that bucket and have real refreshes refused by GoTrue itself.
  With TASK-003g's callback ceiling of 40, the two stay under 150.
- Past the ceiling the session is unverifiable, exactly as past the
  per-network limit: nothing is deleted, and signed-in people whose access
  token is still valid are unaffected, because no refresh is needed for them.

## Invariants

- **Checked before GoTrue.** The proxy decodes the session cookie's
  `expires_at` without a network call. Only when a refresh would be needed
  does it consume the client network's allowance (30 per 5 minutes) and then
  the service-wide one (100 per 5 minutes).
- **Past the limit, nothing is deleted.** The session is treated as
  unverifiable: no GoTrue call, no cookie removed, dashboard paths answer 503
  with a reference, other paths render signed out for this request.
- **The refusal reaches the handlers.** A server action or route handler
  builds its own session client, and creating one lets auth-js refresh in the
  background, so a proxy-only refusal would just move the refresh downstream.
  When the proxy refuses, the session cookie and its chunks are removed from
  the request it forwards. Only this request's view changes: no `Set-Cookie`
  is written, the browser keeps everything, and the PKCE verifier and flow
  ticket are left in place so a sign-in in progress still works.
- **An unreadable cookie is not a refresh.** A cookie that cannot be decoded
  consumes nothing and follows the existing rejection path.
- **Fails closed.** If the limiter cannot be consulted, the session is
  unverifiable, as above.

## Acceptance criteria

- Past the refresh limit, the proxy makes no GoTrue call and deletes no
  cookie.
- A valid, unexpired session consumes no refresh allowance.
- Typecheck, lint, format, unit, security and `test:supabase` pass.

## Required tests

- security: past the per-network limit, and past the service-wide ceiling, the
  proxy makes no GoTrue call and deletes no cookie; an unexpired session makes
  no limiter call at all; limiter failure is unverifiable, not signed out
- unit: reading `expires_at` from a session cookie, including chunked cookies,
  a missing cookie and malformed values
- supabase: a real expired session still refreshes under the limit
