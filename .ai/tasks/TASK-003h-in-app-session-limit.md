# TASK-003h — Enforce the 7-day session limit in the application

## Objective

End every session 7 days after its last sign-in, whatever the hosted Supabase
plan. Hosted Supabase enforces `sessions.timebox` only on a paid plan with the
setting applied, so production sessions would otherwise last until sign-out:
the 7-day cookie cap (TASK-003e) is renewed by every refresh and does not
bound an active session. Raised by the review of PRs #9–#11; the project owner
chose in-app enforcement on 2026-09-19.

## Owner agent

Backend

## Dependencies

TASK-003e (merged in #9).

## How the sign-in time is known (read from GoTrue's source)

Every access token GoTrue issues, refreshed ones included, carries an `amr`
claim built by `Session.CalculateAALAndAMR` (`internal/models/sessions.go`):
one entry per authentication method used in that session, with the time that
method was last used. A token refresh adds no entry, so the newest `amr`
timestamp is the session's last real sign-in.

## Allowed files

- lib/auth/resolve-session-user.ts, lib/auth/errors.ts,
  lib/auth/session-age.ts (new)
- tests/unit/auth/\*\*, tests/security/auth/\*\*, tests/integration/auth/\*\*,
  tests/supabase/auth/\*\*, tests/e2e/auth/support/\*\* (stub tokens become
  JWT-shaped, with an `amr` claim)
- docs/production-setup.md

## Forbidden files

- proxy.ts (it already treats an unauthenticated resolution as signed out)
- lib/database/\*\*

## Invariants

- **Only a validated token is read.** The session's access token is validated
  by the auth server (`getUser(jwt)`) and the claims read from that same token.
  A token whose signature the auth server has not accepted is never decoded
  for a decision.
- **Past 7 days, signed out.** When the newest `amr` timestamp is more than
  7 days old, the session resolves as unauthenticated (`session_expired`): the
  proxy redirects dashboard requests to sign-in and `requireSession` throws.
- **Fails closed.** A token with no readable `amr` claim is treated as
  expired and logged, never as valid for ever.
- **One auth-server round trip, as before.** The claim is read locally; no new
  request.
- **Clock skew:** a timestamp in the future is treated as now.

## Acceptance criteria

- A session signed in 7 days and 1 minute ago is refused by the proxy and by
  `requireSession`; one signed in 6 days ago is accepted.
- A token without `amr` is refused.
- Against real Supabase, `amr` is present, and a refresh keeps its timestamp.
- Typecheck, lint, format, unit, security, integration, e2e and
  `test:supabase` pass.

## Required tests

- unit: the age check at the boundary, with future timestamps, several `amr`
  entries, and malformed or missing claims
- security: the proxy redirects and `requireSession` rejects a session older
  than 7 days whose access token GoTrue still accepts
- supabase: a real session's `amr` survives a refresh with the same timestamp
