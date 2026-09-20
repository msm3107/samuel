## Handoff

### Summary

Closes review finding F2 everywhere it was still open: outside the proxy, and
in the proxy's own background refresh. An auth-server hiccup — a 429 caused by
other people's traffic, a timeout, an outage — no longer signs anyone out.

Raised by the independent review of PRs #9–#11, and by what TASK-003f
uncovered. Lands before TASK-007, the first route handler that resolves a
session.

Stacked on TASK-003f (PR #14) → TASK-003h (#13) → TASK-003g (#12).

### What was wrong, and what each fix does

1. **Handlers applied auth-js's deletions.** After a non-retryable refresh
   failure auth-js deletes the session, and the session client wrote that
   straight into the browser's cookies. `createResolvingSessionClient` now
   **holds** a batch that only removes the session; `requireSession` applies it
   only once the auth server has given a verdict (a rejected credential, or a
   session past its limit), and never when the lookup merely failed.
   A batch that writes a new session and removes its stale chunks is applied at
   once, because holding those would corrupt the next read.
2. **The proxy's background refresh deleted the session mid-request.** Creating
   a session client subscribes to auth events, which makes auth-js refresh an
   expired session on its own; the cookie adapter wrote the resulting deletion
   into the live request. It no longer does.
3. **Keeping the cookie was not enough.** auth-js also drops the session from
   its own memory, so the next `getSession()` answers "no session" even with
   the cookie intact — which read as signed out. A missing session is now a
   verdict **only when the request carried no readable session cookie**;
   otherwise it is a lookup failure, and nothing about the person's cookies is
   decided. The proxy passes that fact, read from the request's own cookies.
4. **Sign-out could leave a session behind.** auth-js clears only what it can
   read, and TASK-003f hides the session from a request whose refresh is over
   the limit — so the browser kept a cookie nothing would clear. Sign-out now
   expires the session cookie and its chunks **by name**, whether or not this
   request can see them. A sign-in in progress keeps its PKCE verifier handling
   as auth-js does it.

### Files changed

- `lib/database/session-client.ts`: `createResolvingSessionClient` (holds
  removal-only batches), `removeSessionCookies`, shared cookie-writing
- `lib/database/proxy-session-client.ts`: removal-only batches stay out of the
  live request
- `lib/auth/resolve-session-user.ts`: the `hadStoredSession` rule
- `lib/auth/require-session.ts`: resolving client, the flag, and applying held
  removals on a verdict
- `lib/auth/sign-in/sign-out.ts`: expire the session cookies by name
- `proxy.ts`: passes `hadStoredSession`
- `.ai/tasks/TASK-003i-session-removal-outside-proxy.md` (amended)
- `tests/security/auth/session-removal.test.ts` (new)

### Security considerations

- Nothing here keeps a session alive that the auth server has refused: a 400,
  401 or 403 still clears the cookies, as does the 7-day limit (TASK-003h).
  Only "I could not tell" is held.
- Sign-out expires cookies by name, so it cannot be prevented by hiding the
  session, an auth-server outage, or a missing local session.
- The held removals are per client instance, so nothing leaks between
  requests.

### Tests

`tests/security/auth/session-removal.test.ts` (11):

- resolving with a 429, 408 or 409 refresh failure deletes no session cookie
  and raises a lookup failure (5xx is left out on purpose: auth-js retries it
  with a long backoff, so the test would measure that timeout)
- a rejected credential does clear the cookies; a valid session is untouched
- after a 60 ms delay the proxy's client still leaves the session in the
  request, and "no session" with a stored cookie is a lookup failure
- end to end: a dashboard request whose background refresh got a 429 answers
  503 and clears nothing
- sign-out clears the session when the auth server fails, when the cookie is
  unreadable, and expires the cookie and its chunks by name when this request
  cannot see them at all — leaving the flow ticket alone

**Mutation check:** 5 mutants (rejected credential leaves cookies, removals
written immediately, missing session always a verdict, removal reaches the
live request, sign-out relies on auth-js only), all caught; files restored,
hash-checked. The last one survived a first attempt — auth-js clears what it
can see — which is what led to expiring the cookies by name.

### Commands run

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`: passed (with the owner's
  untracked `CODEX-SECURITY.md` set aside)
- `pnpm test`: 607 passed
- `pnpm test:integration`: 26 passed
- `pnpm test:security`: 304 passed
- `pnpm test:e2e`: 18 passed

**Not run locally:** `pnpm test:supabase` and `pnpm test:e2e:supabase`, as
Docker is still down. The pull request's End-to-end job runs both.

### Remaining concerns

- **TASK-007 should use `requireSession`,** which now carries these
  guarantees; a route handler that builds its own session client and resolves
  with it would not.
- The 24-hour idle limit still exists only in hosted Supabase's settings
  (`docs/production-setup.md`).
