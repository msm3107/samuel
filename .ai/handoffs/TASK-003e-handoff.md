## Handoff

### Summary

Sessions now end on their own: 7 days after sign-in, or after 24 hours without
activity. The auth server enforces both, and the session cookie is kept no
longer than 7 days (it was 400). The project owner delegated the values on
2026-09-18; the reasoning is in the task contract.

### Files changed

- `supabase/config.toml`: `[auth.sessions]` with `timebox = "168h"` and
  `inactivity_timeout = "24h"`
- `lib/database/session-cookie-options.ts`: `hardenCookieOptions` caps a
  cookie's lifetime at `SESSION_COOKIE_MAX_AGE_SECONDS` (7 days)
- `tests/unit/database/session-cookie-options.test.ts` (new)
- `tests/security/auth/expired-session.test.ts`,
  `tests/security/auth/support/stub-auth-server.ts` (a `session-expired` mode)
- `tests/supabase/auth/sign-in.supabase.ts` (the real refresh cookie's
  `Max-Age`)

### How the limits are enforced (read from GoTrue's source)

- `internal/models/sessions.go`, `CheckValidity`: past the timebox, or idle
  longer than the inactivity timeout, a session is invalid. Idle time counts
  from the last token refresh.
- `internal/tokens/service.go`: a refresh of an invalid session answers
  `400 session_expired`.
- `internal/api/middleware.go`: every authenticated request, including the
  `/user` lookup behind `requireSession` and the proxy, answers
  `403 session_expired`. So the absolute limit applies on the next request,
  not only at the next refresh.
- Both statuses were already treated as a rejected credential: the proxy
  redirects to sign-in and `requireSession` throws `AuthenticationError`. No
  application change was needed there; the new tests pin it.

### Security considerations

- The cap leaves removals alone (maximum age 0, or an expiry in the past), so
  signing out still deletes the cookie. It never lengthens a shorter lifetime.
  Cookies without a lifetime stay browser-session cookies.
- The cap also applies to the PKCE verifier cookies, which only need minutes.
- After a `403 session_expired` on an unexpired access token, no refresh
  happens and auth-js keeps the cookie. It is refused on every request and
  overwritten by the next sign-in. The proxy deliberately does not delete
  cookies by name: the PKCE verifier cookies a pending link needs share the
  session cookie's prefix (review finding F1).

### Tests

- **unit** (8): the 400-day default and a far expiry are capped, a shorter
  lifetime is never lengthened, and removals and browser-session cookies are
  kept. With the cap disabled, 3 fail.
- **security:** a `403 session_expired` lookup redirects to sign-in; a
  `400 session_expired` refresh redirects and clears the cookie. Both pass
  without changes, pinning existing behaviour.
- **supabase:** a real refresh writes `Max-Age=604800`. Runs in CI; Docker is
  down here.

### Commands run

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`: passed (with the
  owner's untracked `CODEX-SECURITY.md` set aside, as before)
- `pnpm test`: 428 passed
- `pnpm test:integration`: 26 passed
- `pnpm test:security`: 242 passed
- `pnpm build`: passed with CI's placeholder environment (it fails without
  environment variables, as it always has)
- `pnpm test:e2e`: 14 passed

**Not run locally:** `pnpm test:supabase` and `pnpm test:e2e:supabase`, because
Docker Desktop is still down. The PR's End-to-end job runs both.

### Remaining concerns

- **Production must match.** Hosted Supabase enforces `timebox` and
  `inactivity_timeout` only when they are set on the project, and only on a
  paid plan. Without them, a production session lasts until sign-out, and only
  the cookie's 7 days limit it (renewed on each refresh).
- Sensitive actions in later phases (deleting an organization, billing
  changes, removing members) should require a recent sign-in in their own
  tasks.
