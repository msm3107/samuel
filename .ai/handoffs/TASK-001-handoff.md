## Handoff

### Summary

Implemented the Supabase client boundary as three server-side factories in
`lib/database/`: a session client for server components, route handlers, and
server actions; a proxy session client for `proxy.ts`; and a service-role
client. No browser client.

**Contract decision: amended, not overruled.** The original contract required a
browser client. It was removed because sign-in, OAuth initiation, and the code
exchange all run server-side, and because a browser client would require
`NEXT_PUBLIC_SUPABASE_*` variables plus widening `connect-src 'self'` in the
CSP. `TASK-001` and the Phase 1 row of `.ai/PLAN.md` were updated, with the
reason recorded under "Amendments" in the task file.

### Files changed

- lib/database/session-client.ts (new)
- lib/database/proxy-session-client.ts (new)
- lib/database/service-role-client.ts (new)
- lib/database/.gitkeep (removed; the directory now has content)
- tests/unit/database/session-client.test.ts (new)
- tests/unit/database/proxy-session-client.test.ts (new)
- tests/unit/database/service-role-client.test.ts (new)
- package.json, pnpm-lock.yaml (three pinned dependencies)
- .ai/tasks/TASK-001-supabase-client-boundary.md (amended contract)
- .ai/PLAN.md (Phase 1 table row)

Not touched: `proxy.ts`, `app/**`, `features/**`, `supabase/migrations/**`,
`vitest.config.ts`.

### Security considerations

- The service-role key is read in exactly one module. It imports `server-only`
  (a client-component import becomes a build failure) and throws at call time
  if `window` is defined.
- The service-role client disables session persistence, auto-refresh, and URL
  session detection, so it cannot pick up and act with a user's identity.
- Both session clients use the anon key only; row-level security applies.
- No factory accepts a user ID, organization ID, or role.
- Keys come from `serverEnv()`. ESLint's `no-restricted-properties` rule already
  rejects `process.env` outside `lib/env`, and the tests mock `lib/env` with
  values distinct from the test environment so a bypass would fail.
- The proxy client never constructs a `NextResponse`. `setAll` updates
  `request.cookies` (so the current render sees refreshed tokens) and queues
  cookies plus the cache headers `@supabase/ssr` passes as `setAll`'s second
  argument. `applySessionCookies(response)` writes them onto the proxy's
  existing response, preserving the CSP nonce headers.
- When a server component cannot write cookies, the session client logs a
  warning with the error name and cookie **names** only, never values, and
  does not throw. This is logged rather than swallowed (`AGENTS.md` §5).

### Dependencies (`README.md` §56)

**`@supabase/supabase-js@2.116.0`** (latest at time of install)

- Problem: the Supabase Auth and database client; Supabase is the chosen stack
  (§3).
- Platform alternative: none short of reimplementing the GoTrue and PostgREST
  protocols.
- Maintenance: actively maintained by Supabase; registry modified 2026-09-07.
- Runs in browser: capable of it, but here it is imported by server modules
  only.
- Permissions: network access to `SUPABASE_URL`.
- Security history: no known advisories for this version at install time.
  Keep it under `pnpm audit` in CI.
- Bundle size: zero client-bundle impact while no client component imports it.

**`@supabase/ssr@0.12.7`** (latest; peer `@supabase/supabase-js ^2.114.0`, depends
on `cookie ^1.0.2`)

- Problem: cookie-backed sessions and PKCE code-verifier storage for SSR.
  `supabase-js` alone stores sessions in `localStorage`.
- Platform alternative: hand-rolled cookie chunking, encoding, and refresh
  handling — exactly the source of the "random logout" failures the Phase 1
  risk note warns about.
- Maintenance: actively maintained by Supabase; registry modified 2026-09-08.
  It is still pre-1.0, so minor versions may break; the exact pin is
  deliberate.
- Runs in browser: not in this design.
- Permissions: none beyond reading and writing cookies it is handed.
- Security history: no known advisories for this version at install time.
- Bundle size: server-only here.

**`server-only@0.0.1`**

- Problem: turns a client-component import of the service-role module into a
  build error — the strongest available guarantee for this task's main
  invariant.
- Platform alternative: the runtime `window` guard, which only fails at runtime
  and only if the code runs. Both are kept.
- Maintenance: published by the React team; a marker package with no logic, so
  its 2022 publish date is not a staleness concern.
- Runs in browser: by design it throws there.
- Permissions: none. It is two files, one of which is empty.
- Security history: none; there is no logic to exploit.
- Bundle size: none.

### Tests

- service-role: throws when `window` is defined, and never constructs a client
- service-role: reads URL and key from `lib/env`, not `process.env`
- service-role: constructed with persistence, refresh, and URL detection
  disabled
- session: anon key from `lib/env`, never the service-role key
- session: reads cookies from the request cookie store
- session: writes refreshed cookies when the context allows
- session: logs, does not throw, and does not log cookie values when a server
  component cannot write
- proxy: anon key from `lib/env`, never the service-role key
- proxy: reads the incoming request's cookies
- proxy: a refreshed token is visible on `request.cookies` and the `cookie`
  header
- proxy: applying cookies preserves an existing `Content-Security-Policy`
  header
- proxy: applied responses carry `Cache-Control: no-store`
- proxy: no refresh leaves `set-cookie` and `Cache-Control` unset

**Mutation check.** Seven deliberate breakages were each caught by a failing
test, then reverted:

1. browser guard removed
2. session client given the service key
3. proxy client given the service key
4. request-cookie update removed
5. cache headers dropped
6. cookie values logged
7. service-role session persistence enabled

Isolation note: `server-only` is neutralised with a per-file
`vi.mock("server-only", () => ({}))` in the service-role test rather than a
`vitest.config.ts` alias, which keeps this task inside its allowed files. If
more test files come to import the service-role module transitively, a config
alias becomes the cleaner option. That is a scope decision for the task that
needs it.

### Commands run

Baseline on the unmodified branch:

- `pnpm typecheck`: passed
- `pnpm lint`: passed
- `pnpm test`: passed (24 tests)
- `pnpm format:check`: **failed on 47 unmodified files.** Cause: the system Git
  configuration sets `core.autocrlf=true`, so the checkout had CRLF line
  endings. Fixed locally with `git config core.autocrlf false` and a
  re-checkout, after which it passed. No repository file was changed for this.

After the change:

- `pnpm vitest run tests/unit/database` before implementation: failed (3
  suites, module not found)
- `pnpm vitest run tests/unit/database` after implementation: passed (13 tests)
- `pnpm typecheck`: passed (exit 0)
- `pnpm lint`: passed (exit 0)
- `pnpm format:check`: passed (exit 0)
- `pnpm test`: passed (7 files, 37 tests)
- `pnpm build`: passed. Run with placeholder values for both Supabase keys; a
  recursive search of `.next/` found 0 files containing either placeholder.
- `next start -p 3100` plus a request to `/` (CSP baseline for TASK-002, since
  `proxy.ts` is unchanged): status 200, 8 of 8 `<script>` tags carry the nonce
  from the `Content-Security-Policy` response header, and a second request got
  a different nonce. `X-Content-Type-Options`, `Referrer-Policy`, and
  `Strict-Transport-Security` are present.

Not run:

- `pnpm test:integration` and `pnpm test:security`: this task adds neither kind
  of test.
- `supabase start` / `supabase db reset`: this task has no schema and its tests
  mock Supabase.

### Remaining concerns

- **The build-output search is weak evidence today.** Nothing under `app/`
  imports `lib/database` yet, so a clean result was guaranteed. Re-run it in
  TASK-002 once the proxy and dashboard layout import the session clients.
- **The `server-only` build failure has not been demonstrated.** Proving it
  requires a client component that imports the service-role module, and `app/`
  is forbidden in this task. Suggested follow-up: a throwaway, uncommitted
  client import in TASK-002, where `pnpm build` is expected to fail.
- **Wiring order for TASK-002.** In `proxy.ts`:
  1. Create the proxy client.
  2. Call `supabase.auth.getUser()` **before** `new Headers(request.headers)`,
     otherwise the copied headers carry the pre-refresh cookie.
  3. Call `applySessionCookies(response)` before returning.
  4. Re-verify the nonce on the wire against the 8/8 baseline above.
- **`getUser()` versus `getClaims()`.** The installed `@supabase/ssr` types
  recommend `getClaims()`. It verifies the JWT locally when the project uses
  asymmetric signing keys and falls back to a network call otherwise. The Phase
  1 brief specifies `getUser()`. TASK-002 should make this choice explicitly,
  not by default.
- **Route handlers cannot forward `@supabase/ssr`'s cache headers.** The
  session client receives them but can only write cookies through
  `next/headers`. TASK-003's `/auth/callback` route should set
  `Cache-Control: no-store` on the response it returns.
- **Untyped queries.** The clients use `@supabase/ssr` and `supabase-js`'s
  default `Database = any` generic because no schema exists yet, so query
  results are untyped. Generate types after TASK-004's migration and pass them
  to all three factories.
- **For TASK-003:**
  - With PKCE, a magic link only completes in the browser that requested it.
    Decide whether that is acceptable or whether to use the `token_hash` flow.
  - A Google sign-in started by a form that redirects cross-origin can be
    blocked by `form-action 'self'` when JavaScript is disabled. Starting it
    from a GET route handler avoids this.
- **Line endings.** A `.gitattributes` with `* text=auto eol=lf` would stop
  Windows checkouts from failing `format:check`. It is outside this task's
  allowed files.
