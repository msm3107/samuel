## Handoff

### Summary

Implemented session resolution and dashboard route protection.

- `requireSession()` resolves identity from the session cookie, validated by
  the auth server with `getUser()`. It takes no arguments and throws a typed
  `AuthenticationError`; it never returns null.
- Enforcement is layered, and each layer covers a gap in the others:
  1. **The proxy**, on every request to a `/dashboard` path:
     - signed out: `303` to `/sign-in`
     - session cannot be verified: `503` with a reference code
     - signed in: the request is forwarded
  2. **The dashboard layout** repeats the check server-side.
  3. **Data access** in later phases must call `requireSession()` itself.
     Layouts do not re-run on client navigation, and Next.js can skip them for
     RSC requests.

Branch `feat/session-route-protection` is stacked on
`feat/supabase-client-boundary` (TASK-001, PR #2, not yet merged).

The tests were written by five parallel agents, one file each. An adversarial
security agent and an independent reviewer then reviewed the change.

- **First security verdict: `REJECT`.** One blocking finding (below). It was
  fixed, and a second security pass returned
  `APPROVE WITH NON-BLOCKING NOTES`.
- **Reviewer verdict:** `APPROVE WITH NON-BLOCKING NOTES`.

### Blocking finding from security review, and the fix

The original proxy forwarded dashboard requests whenever the session lookup
failed, and relied on the layout to fail closed. The attacker needs no
account:

1. Set a session cookie whose access token is not a valid HTTP header value,
   for example one containing a newline.
2. `fetch` refuses the header locally, and auth-js reports it as
   `AuthRetryableFetchError`.
3. The lookup "failed", so the proxy forwarded the request.

The only remaining gate was the layout, which Next.js can skip on RSC requests
carrying router-state headers. The fail-open also exposed which dashboard
routes exist (500 from an existing route versus 404).

The fix: for dashboard paths, an unverifiable session now gets a fixed
`503`:

- `Cache-Control: private, no-store`
- body `Something went wrong. Please try again. Reference: err_<12 hex>`
- the same response for every path
- never forwarded to rendering

Non-dashboard paths are still forwarded, so an auth outage does not take down
public pages.

I reproduced the exploit before the fix (status 200, `x-middleware-next: 1`,
zero auth-server calls). After the fix it returns 503, both in the test suite
and against `next start`, including with `RSC` and `Next-Router-State-Tree`
headers.

### Files changed

- proxy.ts (modified: session state, redirect, 503, cookie application)
- app/(dashboard)/layout.tsx (new)
- app/(dashboard)/dashboard/page.tsx (new, placeholder; see Amendment)
- app/(dashboard)/.gitkeep (removed)
- .ai/tasks/TASK-002-session-and-route-protection.md (amended: page allowed)
- lib/auth/errors.ts (new)
- lib/auth/resolve-session-user.ts (new)
- lib/auth/require-session.ts (new)
- lib/auth/protected-routes.ts (new)
- lib/auth/.gitkeep (removed)
- tests/security/auth/support/stub-auth-server.ts (new, shared harness)
- tests/security/auth/stub-auth-server.smoke.test.ts (new)
- tests/security/auth/unauthenticated-dashboard.test.ts (new)
- tests/security/auth/client-supplied-identity.test.ts (new)
- tests/security/auth/expired-session.test.ts (new)
- tests/security/auth/session-lookup-failure.test.ts (new)
- tests/security/auth/dashboard-route-layout.test.ts (new)
- tests/integration/auth/authenticated-dashboard.test.ts (new)
- .ai/handoffs/TASK-002-handoff.md (this file)

Nothing outside TASK-002's allowed files (as amended) was modified, apart from
this handoff and the removal of the two empty `.gitkeep` files.

### Security considerations

- **Identity.** Identity comes only from the cookie's access token, validated
  by the auth server. A test shows that a cookie claiming user B but carrying
  user A's token resolves to user A. Query `userId`, `x-user-id`, a forged
  `Authorization: Bearer` header, and a JSON body all have no effect.
- **Failure classification** (`resolveSessionUser`):
  - no session → `session_missing`
  - auth-server 400, 401, or 403 → `session_invalid`
  - everything else → `SessionLookupError`, which fails closed as an error
    rather than a redirect. "Everything else" covers network failure, 5xx, 429,
    any other status, a non-UUID or missing user id, and a token that auth-js
    refused to send.
  - Narrowed from "any 4xx" after review, so a misconfigured gateway returning
    404 or 408 cannot sign every user out.
- **Redirect.**
  - `303`, so a POST whose session expired is followed by a GET and its body
    is never re-sent.
  - The origin comes from `NEXT_PUBLIC_APP_URL`, not the `Host` header, and
    the redirect carries no trace of the requested path or query.
  - `Cache-Control: private, no-store`.
  - The response is identical for existing and non-existent paths.
- **Path normalization.** `isDashboardPath` percent-decodes, collapses repeated
  slashes, and lowercases before matching `^/dashboard($|/|.)`. The trailing
  `.` covers the App Router transport forms (`/dashboard.rsc`,
  `/dashboard.segments/…`), which the second security pass found reach the
  proxy with only `.rsc` stripped. A path that cannot be decoded is treated as
  protected.
- **Route placement.**
  - The proxy guards the URL prefix; the layout guards the `(dashboard)` route
    group.
  - `tests/security/auth/dashboard-route-layout.test.ts` fails if any
    `page`/`route`/`default` file under `app/(dashboard)` is outside
    `app/(dashboard)/dashboard/`, or if an intercepting route exists there.
  - It checks the placeholder dashboard page today, and will catch misplaced
    pages as more are added.
- **Proxy ordering.** `getUser()` runs before `request.headers` is copied, so
  server components receive refreshed cookies. A mutation that forwards the
  stale cookie fails 3 tests.
- **Session cookies** are applied to every proxy response, including redirects
  (cookie clearing for a rejected session is tested) and the 503.
- **Logs.** The 503 log line records `event`, `code`, `reference`, the cause's
  error `name`, and its numeric `status`. It never records the message, which
  for a rejected header can contain the token. A test asserts the token is
  absent.
- **CSP.** The existing policy and security headers are unchanged and applied
  to every proxy response. After the final changes, 8 of 8 script tags on `/`
  served by `next start` carry the nonce from the response header.

### Tests

Seven suites, 137 tests, in `tests/security/auth/` and
`tests/integration/auth/`. They run against a stub auth server installed as
`fetch`, so the real `@supabase/ssr` and `supabase-js` code paths execute:

- cookie decoding
- expiry detection
- refresh and refresh rejection
- revocation (`session_not_found`, with the versioned API header GoTrue sends)
- session removal
- header-invalid tokens

This keeps them runnable in CI, which has no Supabase instance.

Required tests from the contract:

- **integration: authenticated request reaches the dashboard**
  (`authenticated-dashboard.test.ts`). The proxy forwards with matching nonce
  headers, the layout returns its children, and the placeholder page renders.
  The rendered page was also checked end to end through `next start` (see
  "Commands run"). A real Supabase instance was not used.
- **security: unauthenticated request redirects and reveals nothing**
  (`unauthenticated-dashboard.test.ts`)
- **security: client-supplied `userId` does not change identity**
  (`client-supplied-identity.test.ts`)
- **security: expired session is rejected** (`expired-session.test.ts`):
  expired with a rejected refresh, revoked, garbage cookies, and a successful
  refresh.

Also covered:

- Lookup failures fail closed (`session-lookup-failure.test.ts`): network
  failure, 500/503/429, 404/408/409, malformed user response, header-invalid
  tokens, identical 503s, no secrets in errors or logs.
- Route placement guard (`dashboard-route-layout.test.ts`).

**Mutation check.** Sixteen independent mutations, each reverted and
hash-verified. Every one failed at least one test:

| #   | Mutation                                    | Tests failed |
| --- | ------------------------------------------- | ------------ |
| 1   | fail open on lookup failure                 | 10           |
| 2   | any 4xx = signed out                        | 6            |
| 3   | 307 redirect                                | 10           |
| 4   | forward stale cookies                       | 3            |
| 5   | no percent-decoding                         | 7            |
| 6   | no slash or case normalization              | 8            |
| 7   | `getSession()` instead of `getUser()`       | 69           |
| 8   | layout skips the check                      | 14           |
| 9   | layout rethrows instead of redirecting      | 9            |
| 10  | skip user-id validation                     | 3            |
| 11  | proxy never writes cookies                  | 5            |
| 12  | redirect origin from the Host header        | 23           |
| 13  | cacheable redirect                          | 1            |
| 14  | transport URLs unprotected                  | 5            |
| 15  | no failure class in the log                 | 1            |
| 16  | narrowed route-file guard (test self-check) | 1            |

An earlier batch of mutation runs was invalid: my restore step did not restore
the files, so mutations accumulated. I reverted every mutation by hand,
confirmed 124 of 124 tests passing, and re-ran everything with in-memory
restore and a hash check. Only the valid runs are reported above.

### Commands run

Final state, after all review fixes:

- `pnpm typecheck`: passed (exit 0)
- `pnpm lint`: passed (exit 0)
- `pnpm format:check`: passed (exit 0)
- `pnpm test`: passed, 14 files, 171 tests. Stderr shows expected library
  warnings from the garbage-cookie and rejected-refresh cases.
- `pnpm test:integration`: passed, 1 file, 14 tests
- `pnpm test:security`: passed, 8 files, 133 tests
- `pnpm build`: passed. Built with placeholder values for both Supabase keys;
  a case-sensitive search of `.next/` found 0 files containing either. A
  case-insensitive search matches React's `react.memo_cache_sentinel` symbol,
  which is not a leak.
- `next start -p 3100`, probed with `curl`:
  - `/`: 200, 8 of 8 script nonces match the CSP header
  - `/dashboard` with no cookie: 303 to `/sign-in`, `private, no-store`
  - `/dashboard.segments/_tree.segment.rsc` with `RSC: 1` and no cookie: 303
  - newline-token cookie on `/dashboard/systems`: 503, no `x-middleware-next`
  - log line: `causeName: AuthRetryableFetchError`, `causeStatus: 0`, no token

  Earlier probes against the same fix, before the last three non-blocking
  changes:
  - spoofed `Host`, `?next=https://evil.example`, forged identity headers,
    garbage cookie, `/%64ashboard`, `/DASHBOARD/settings`: all an identical
    redirect
  - POST: 303
  - HEAD with a well-formed cookie while Supabase is unreachable: 503
  - newline token plus RSC and router-state headers: 503
  - existing and non-existent paths: identical 503s

After adding the placeholder dashboard page (see "Amendment" below):

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`: passed
- `pnpm test`: passed, 14 files, 174 tests
- `pnpm test:integration`: passed, 1 file, 16 tests
- `pnpm test:security`: passed, 8 files, 134 tests
- `pnpm build`: passed; `/dashboard` is listed as a dynamic route, and a
  case-sensitive search of `.next/` found neither placeholder key.
- End to end through `next start -p 3100`, with `SUPABASE_URL` pointing at a
  small HTTP stub of the auth endpoints (a scratch script, not committed):
  - authenticated `/dashboard` (valid token cookie, sent with `curl`): 200,
    `<h1>Dashboard</h1>` rendered, 8 of 8 script nonces match the CSP header,
    no user id or email in the HTML
  - auth-server `/user` lookups for that one request: 2, one from the proxy
    and one from the render. The layout and page both call the check and
    shared a single lookup, so `cache()` deduplication holds in a real render.
  - no cookie: 303 to `/sign-in`, 0 lookups
  - forged token: 303 to `/sign-in`, 1 lookup
  - `RSC: 1` with a router-state header naming `(dashboard)`, no cookie: 303,
    placeholder text absent from the body

  Windows PowerShell's `Invoke-WebRequest` silently drops a manually set
  `Cookie` header. A first attempt with it returned 303 with 0 lookups; that
  result was discarded and the check was repeated with `curl`.

Not run: anything against a real Supabase instance (see below).

### Amendment: placeholder dashboard page

The project owner approved adding `app/(dashboard)/dashboard/page.tsx`, and the
TASK-002 contract records it. The page:

- renders a heading and one sentence, with no user or organization data
- calls `requireDashboardSession()` itself, because Next.js can render a page
  without re-running its layout

Tests added:

- **integration:** the page renders for an authenticated request and contains
  nothing identifying the user.
- **security:** the page redirects to sign-in on its own when no session
  exists. Removing its check fails this test.

The route-placement guard is no longer vacuous: the page sits under
`app/(dashboard)/dashboard/`. The empty `app/(dashboard)/.gitkeep` was removed.

### Remaining concerns

**Needs a decision from you** (outside TASK-002's allowed files):

1. **No test runs against real Supabase.** Three things block it:
   - `supabase/config.toml` does not exist, and `supabase/` is not an allowed
     path.
   - `pnpm test` runs all of `tests/**` in CI, which has no Supabase, so a
     real-Supabase test would fail CI unless CI starts Supabase (`ci.yml`,
     not allowed) or such tests move to a separately-run project
     (`vitest.config.ts`, not allowed).
   - Docker Desktop crashes locally (below).

   This matters because the Phase 1 exit criterion ("sign-in works end to end
   against a local Supabase instance") needs it, and real GoTrue response
   shapes, token rotation, and chunked cookies are only simulated.

2. **Docker Desktop fails on launch on this machine.** Its log shows it cannot
   remove stale socket reparse points from 24 June under
   `%LOCALAPPDATA%\Docker\run` (`dockerInference`, `dockerEthernetVfkit`,
   `userAnalyticsOtlpHttp.sock`; Windows error 1920). They were not touched.
   The usual remedy is to quit Docker, delete those files (a reboot may be
   needed first), and restart it.

**Accepted for now, to be tracked** (from the security re-review):

3. **Refresh failures that are not retryable sign the user out.** For an
   expired access token, auth-js removes the session on any non-retryable
   refresh failure (429, 404, 408), so the 503 carries a clearing cookie and
   the next request goes to sign-in. The "no sign-in loop during an outage"
   goal therefore holds only for 5xx and network failures. This is library
   behaviour. It is an input to Phase 6 rate limiting.
4. **Every matched path calls `getUser()`.** A request with junk cookies
   causes an outbound auth call; a request with no cookie makes none. Kept
   because TASK-001's session client relies on the proxy refreshing before
   rendering. Rate limiting is the Phase 6 shared primitive that Phase 1
   adopts retroactively.
5. **Slow requests during an auth outage.** Requests with an expired session
   wait for auth-js's retry backoff (about 25 seconds each in the security
   agent's measurement), on every matched path. Bounding this needs a fetch
   timeout in `lib/database/proxy-session-client.ts`, a TASK-001 file.
6. **Unhandled rejection from a malformed cookie.** A cookie whose `user`
   field is not an object causes an unhandled promise rejection inside auth-js
   (`insecureUserWarningProxy`). The request itself is handled correctly with
   a 503. Next's server only logs unhandled rejections, but the deployment
   runtime's behaviour is unverified. Worth an upstream report.
7. **A header-invalid token cookie is never cleared.** auth-js treats the
   failure as retryable, so that browser keeps getting 503 until its cookies
   are cleared. The new log fields make this distinguishable from an outage.

**Notes for later tasks:**

- Every dashboard page must live under `app/(dashboard)/dashboard/`, and every
  data loader must call `requireSession()` (or `requireOrganizationRole()`)
  itself.
- The stub harness in `tests/security/auth/support/` is shared; extend it
  rather than writing another.
- `requireSession()` is wrapped in React `cache()` for per-render
  deduplication. That was observed once end to end (2 lookups per
  authenticated dashboard request: proxy plus render). No automated test
  covers it, because Vitest does not run the react-server build.
- The TASK-001 handoff raised `getUser()` versus `getClaims()`. TASK-002 uses
  `getUser()`, as the Phase 1 brief specifies. `getClaims()` would avoid a
  network call per request with asymmetric JWT keys, but changes the
  revocation guarantee; revisit only deliberately.
