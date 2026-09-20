## Handoff

### Summary

The proxy now consumes a rate-limit allowance before any token refresh reaches
the auth server, closing the availability half of review finding F2. Every
expired session makes the proxy refresh from this application's own address,
and GoTrue counts refreshes per client IP, so anonymous junk cookies could
exhaust that budget and have everyone else's refresh refused.

- Client network: 30 refreshes per 5 minutes.
- Service-wide: 100 per 5 minutes, under GoTrue's own per-IP token bucket
  (150 per 5 minutes, shared with TASK-003g's 40 callback exchanges).

Past either, or when the limiter cannot answer, the session is **unverifiable**:
no auth-server call, no cookie removed, 503 with a reference on dashboard
paths. Nobody is signed out by a limit.

Stacked on TASK-003h (PR #13), which is stacked on TASK-003g (PR #12).

### A latent race this uncovered, and how it is handled

Creating a session client subscribes to auth events (`@supabase/ssr`'s
`createServerClient` calls `onAuthStateChange`), and that makes auth-js load
the session and, when the access token has expired, **refresh it in the
background** with nobody calling it. On a 429 the background refresh removes
the session, and the cookie adapter writes that removal straight into the
request's cookies.

F2's guarantee in the proxy therefore held only because the proxy awaited its
own `getSession()` immediately after creating the client. Adding the limiter
call in between was enough to lose the race: the session vanished from the
request, the proxy saw "no session", and a 429 signed the person out — with
the cookie cleared. Proved with a probe: create the client, wait 50 ms, call
nothing, and the session cookie is already empty.

This task consults the limiter **before the client exists**, which both fixes
the ordering and means a refused request never starts a background refresh at
all. The underlying fragility (any future await in between re-breaks it) is
recorded in the TASK-003i contract, with the required regression test.

### The pre-PR review found two blockers, both fixed

Reviewers (security, contract) plus an adversarial verifier: 4 findings, 3
confirmed, 1 rejected as already-accepted in the contract.

1. **The refusal did not reach the handlers.** The proxy passes a request on
   after refusing, and a server action or route handler then builds its own
   session client — which refreshes in the background, unmetered. A limit that
   only moved the refresh downstream is no limit. Fixed: when the proxy
   refuses, the session cookie and its chunks are stripped from the request it
   forwards. Nothing is written to the browser, and the PKCE verifier and flow
   ticket are kept, so a sign-in in progress still completes.
2. **Unreadable cookies were billed as refreshes**, against this task's own
   invariant. The reviewer showed auth-js treats an undecodable cookie as no
   session and makes no request for it, so garbage cookies could have drained
   the shared ceiling for free. Fixed: an unreadable cookie is `none`, and a
   test proves three junk values spend nothing.
3. **Scope:** `lib/security/rate-limit.ts` was edited without being in this
   task's Allowed files. Added, with the reason.

The rejected finding — a few networks can still reach the service-wide
ceiling — is the residual risk this task's amendment already states.

### Files changed

- `lib/auth/session-expiry.ts` (new): reads the session cookie's `expires_at`
  locally, reassembling chunked cookies, so the proxy knows whether a request
  would cost a refresh without asking anyone; an undecodable cookie counts as
  no session
- `proxy.ts`: `mayRefreshSession` before the session client; past a limit the
  client is never created, the state is unverifiable, and the session cookie
  is stripped from the forwarded request so handlers cannot refresh either
- `lib/security/rate-limit.ts`: `sessionRefreshGlobal`,
  `sessionRefreshCeilingAlert`
- `.ai/tasks/TASK-003f-session-refresh-limit.md` (amended),
  `.ai/tasks/TASK-003i-session-removal-outside-proxy.md` (the race)
- Tests below; three suites gained the `server-only` mock, because the proxy
  now reaches the limiter

### Security considerations

- Only requests that would actually refresh spend an allowance: a valid
  session and a request with no session at all spend nothing, so ordinary
  traffic cannot exhaust the limit.
- An unreadable session cookie counts as no session, because auth-js treats an
  undecodable value that way and asks the auth server for nothing. Billing it
  as a refresh would have let junk cookies drain the shared ceiling.
- The alert past the service-wide ceiling is written at most once per 5
  minutes, so an attacker does not decide the error-log volume.
- Failing closed here means unverifiable, never signed out: a limit must not
  delete anyone's session, which was the point of F2.

### Tests

- **security** (`tests/security/rate-limit/session-refresh-limit.test.ts`,
  10): past the network limit and past the service-wide ceiling, no
  auth-server call, 503, and no clearing cookie — on dashboard and
  non-dashboard paths; a valid session, a request without a session and three
  unreadable cookie values spend nothing; under both limits the refresh
  happens as before; a limiter failure is unverifiable, not signed out; a
  refused request reaches handlers with no session cookie while the flow
  ticket and PKCE verifier stay, and an allowed one forwards the session
  untouched.
- **unit** (`tests/unit/auth/session-expiry.test.ts`, 12): valid, expired and
  exactly-now sessions; chunked cookies; PKCE verifier cookies ignored;
  unreadable values reported as no session; a decodable session with junk
  tokens still counted as a refresh.
- **Mutation check:** 8 mutants, all caught — no refresh limit, no ceiling,
  limiter failure fails open, unreadable cookie treated as free, limit spent
  on every request, refusal not forwarded, forwarded cookies left untouched,
  unreadable billed as a refresh. Files restored, hash-checked.

### Commands run

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`: passed (with the owner's
  untracked `CODEX-SECURITY.md` set aside)
- `pnpm test`: 596 passed
- `pnpm test:integration`: 26 passed
- `pnpm test:security`: 293 passed
- `pnpm test:e2e`: 18 passed

**Not run locally:** `pnpm test:supabase` and `pnpm test:e2e:supabase`, as
Docker is still down. The pull request's End-to-end job runs both.

### Remaining concerns

- **Throughput:** 100 refreshes per 5 minutes across the service is about
  1,200 an hour. At roughly one refresh per user per hour that is ~1,200
  active users; raise it, and GoTrue's own token limit, together.
- **Sign-out while the refresh limit is exhausted** cannot reach the auth
  server, because the session is hidden from that request. TASK-003i's
  invariant "sign-out still signs out, including when the auth server cannot
  be reached" covers it, and must land before dashboards ship.
- **TASK-003i** now owns the background-refresh race as well as the server
  action and route handler case, and should land before TASK-007.
