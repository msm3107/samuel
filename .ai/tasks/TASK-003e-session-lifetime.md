# TASK-003e — Session lifetime

## Objective

End sessions on their own. Until now a session lasted until the person signed
out, in a cookie kept for 400 days. Sessions now have an absolute limit and an
idle limit, both enforced by the auth server, and the cookie is kept no longer
than the absolute limit.

## Owner agent

Backend

## Dependencies

TASK-003d (sign-in hardening), merged.

## Decision (project owner delegated the values, 2026-09-18)

| Setting                    | Value    | Why                                                     |
| -------------------------- | -------- | ------------------------------------------------------- |
| Absolute limit (`timebox`) | 7 days   | A weekly sign-in by email is tolerable for a dashboard  |
| Idle limit (`inactivity`)  | 24 hours | Daily users stay signed in; a forgotten device does not |
| Session cookie maximum age | 7 days   | Never outlives the session it carries                   |

Signing in is an email round trip, so limits in the OWASP ASVS Level 2 range
(12 hours) would make the product tiresome to use every day. Later phases that
take irreversible or billing actions (deleting an organization, changing the
plan, removing members) should ask for a recent sign-in instead, in their own
tasks.

## Allowed files

- supabase/config.toml (`[auth.sessions]`)
- lib/database/session-cookie-options.ts (cap the cookie's maximum age)
- tests/unit/database/\*\*, tests/security/auth/\*\*, tests/supabase/auth/\*\*

## Forbidden files

- proxy.ts, lib/auth/\*\* (the existing rejection path already signs out)

## Invariants

- **The auth server enforces both limits.** GoTrue checks them on every
  refresh (`400 session_expired`) and on every authenticated request, including
  the user lookup behind `requireSession` (`403 session_expired`). Idle time
  counts from the last refresh. Both statuses are already treated as a
  rejected credential: signed out, cookies cleared.
- **The cookie never outlives the session.** Every cookie the session clients
  write has a maximum age of at most 7 days. Removals (maximum age 0) are
  untouched.
- **Production must match.** Hosted Supabase applies these limits only when set
  on the project (a paid-plan feature). Local `config.toml` is never pushed.

## Acceptance criteria

- `config.toml` sets `timebox = "168h"` and `inactivity_timeout = "24h"`.
- A session cookie written with the library's 400-day default is capped at 7
  days; a shorter maximum age, none at all and a removal are kept as they are.
- A `session_expired` rejection from the auth server signs the person out.
- Typecheck, lint, format and unit and security tests pass.

## Required tests

- supabase: a real refresh writes the session cookie with a 7-day maximum age
- unit: the cap applies to a long maximum age; a shorter one, none at all (a
  browser-session cookie) and a removal are kept
- security: a `403 session_expired` user lookup redirects to sign-in; a
  `400 session_expired` refresh redirects and clears the session cookie. After
  a 403 the unexpired access token means no refresh happens, so auth-js keeps
  the cookie; it is refused on every request and overwritten by the next
  sign-in. The proxy does not delete cookies by name, because the PKCE
  verifier cookies a pending link needs share the session cookie's prefix.
