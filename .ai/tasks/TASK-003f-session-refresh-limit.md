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
- tests/unit/auth/\*\*, tests/security/auth/\*\*, tests/security/rate-limit/\*\*,
  tests/supabase/auth/\*\*

## Forbidden files

- lib/database/\*\*, supabase/migrations/\*\*

## Invariants

- **Checked before GoTrue.** The proxy decodes the session cookie's
  `expires_at` without a network call. Only when a refresh would be needed
  does it consume one "session refresh" allowance for the client network:
  30 per 5 minutes.
- **Past the limit, nothing is deleted.** The session is treated as
  unverifiable: no GoTrue call, no cookie removed, dashboard paths answer 503
  with a reference, other paths render signed out for this request.
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

- security: past the refresh limit, the proxy makes no GoTrue call and deletes
  no cookie; an unexpired session makes no limiter call; limiter failure is
  unverifiable, not signed out
- supabase: a real expired session still refreshes under the limit
