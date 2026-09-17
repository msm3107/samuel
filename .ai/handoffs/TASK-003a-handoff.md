## Handoff

### Summary

Implemented the server side of sign-in: requesting a magic link, starting
Google OAuth, completing the PKCE exchange in `/auth/callback`, and signing
out. The sign-in screen (TASK-003) calls these and renders result codes; it
decides nothing.

Branch `feat/sign-in-server-flow`, stacked on `feat/session-route-protection`
(TASK-002, PR #3), which is stacked on `feat/supabase-client-boundary`
(TASK-001, PR #2). Neither is merged yet.

Tests were written by parallel agents, one file each, then an adversarial
security agent and an independent reviewer reviewed the whole task.

- **Both first-round verdicts: `REJECT`.** Every blocking finding below is
  fixed.
- The first agent run died on a session limit; three test files survived and
  were verified and repaired by hand.

### Cookie hardening — a TASK-001 fix made here

The security agent found that session cookies were written **without
`HttpOnly` and without `Secure`**, so the access and refresh tokens were
readable by any injected script. This was TASK-001 behaviour (`@supabase/ssr`
leaves `httpOnly` unset so that a browser client can read the session), not
something TASK-003a introduced — but sign-in is what starts writing those
cookies for real.

`lib/database/session-cookie-options.ts` now hardens every session cookie
before it is written, and both session clients use it:

- `httpOnly: true` — this application has no browser Supabase client, so
  nothing legitimate reads the cookie from JavaScript
- `secure` everywhere except development, where `http://localhost` would
  otherwise never receive it
- `sameSite: "lax"` and `path: "/"` defaults

`lib/database/**` is outside TASK-003a's allowed files. Fixing a live
token-exposure took priority over the file boundary (`AGENTS.md` §1), and it
is recorded in the TASK-003a contract's Amendments. Verified on the wire:
`set-cookie: sb-127-auth-token=...; Secure; HttpOnly; SameSite=lax`.

### Other blocking findings, and the fixes

1. **HTTP parameter pollution.** A callback carrying two `code` values was
   resolved by taking the first and exchanging it, spending a single-use code
   the caller did not choose; an edge proxy and the application could also
   disagree about which value counts. The callback now refuses any repeated
   `code` or `sb_flow_id`: the ambiguous input is passed through as an array,
   fails validation, and answers `link_invalid`.
2. **Typecheck and format failures** in test files whose agents were killed
   before verifying them. Fixed; all gates now pass.

### Non-blocking findings addressed

- An **expired magic link** arrives as `error_code=otp_expired` with no code at
  all, so it produced a generic failure. It now answers `link_expired`, and the
  unreachable `otp_expired` entry moved to the provider-error path.
- **`signup_disabled` was an enumeration oracle**: only an unregistered address
  can produce it, so returning `unavailable` said "no account here". It now
  returns the same confirmation as everything else, and is logged.
- **Throttled sends were invisible.** `over_email_send_rate_limit` now logs
  `magic_link_not_sent` with the code and no address.
- **`flowIdSchema`** was wider (1–128) than auth-js's own pattern; it now
  matches `^[a-zA-Z0-9_-]{8,64}$`, so an id auth-js would never mint reads as
  an invalid link rather than as one opened in another browser.
- **`createSessionClient()` sat outside the try**, so a configuration failure
  escaped as a 500 without cache headers. It is inside now.
- **A server action trusted its argument.** `requestMagicLinkAction` checks
  that it received `FormData`.
- Contract documents: TASK-003b's isolation invariant described a Vitest config
  it forbade creating (real-Supabase files are now named `*.supabase.ts`), and
  the `package.json` overlap with TASK-003 is called out for sequencing.
- The smoke test that `sign-in-flow.test.ts` subsumed was deleted.

### Files changed

- lib/auth/sign-in/: result-codes.ts, email.ts, urls.ts, request-magic-link.ts,
  start-google-sign-in.ts, complete-sign-in.ts, sign-out.ts, actions.ts (new)
- app/(auth)/auth/callback/route.ts (new)
- lib/database/session-cookie-options.ts (new), session-client.ts,
  proxy-session-client.ts (hardening)
- tests/unit/auth/sign-in-inputs.test.ts (new)
- tests/security/auth/magic-link-and-google-start.test.ts (new)
- tests/security/auth/sign-in-callback.test.ts (new)
- tests/integration/auth/sign-in-flow.test.ts (new)
- tests/security/auth/support/stub-auth-server.ts (OTP, PKCE exchange, logout,
  recorded bodies)
- tests/unit/database/session-client.test.ts and proxy-session-client.test.ts
  (cookie-hardening tests)
- .ai/tasks/TASK-003a-\*.md (new), TASK-003b-\*.md (new draft),
  TASK-003-sign-in.md (amended), .ai/PLAN.md, this handoff

### Security considerations

- **Login CSRF** is blocked by PKCE: a code is useless without the verifier
  cookie this browser stored. Verified end to end — a code with no verifier
  answers `link_other_browser` and establishes no session.
- **No enumeration:** unknown addresses create accounts, and every
  registration-dependent failure maps to the same confirmation.
- **No open redirect:** every URL is built from `NEXT_PUBLIC_APP_URL`, so a
  spoofed `Host` or `X-Forwarded-Host` changes nothing. There is no `next`
  parameter to abuse.
- **No reflection:** the callback's `Location` carries exactly one parameter, an
  allowlisted code. Hostile `code`, `error`, `error_description` and
  `sb_flow_id` values never appear in it.
- **Every callback response** is a `303` with `Cache-Control: private, no-store`.
- **Logs** carry event names, result codes and error identifiers only — never an
  address, code, verifier or token.
- **Sign-out** is a server action, so Next.js enforces its origin check; it is
  never reachable by GET.

### Tests

**366 tests across 18 files** (`pnpm test`). The four sign-in test files hold
190 of them. They run the real `@supabase/ssr` and `supabase-js`
code against a stub auth server, so they need no Supabase instance.

Coverage includes: email normalization and rejection; identical results for
registered and unregistered addresses; OTP failure mapping; PKCE verifier
storage; the Google URL origin check; login CSRF; replay; expired flows;
malformed codes and flow ids; duplicate parameters; hostile input never
reaching the redirect; Host spoofing; outage mapping; cookie hardening; and
full magic-link, Google and sign-out round trips.

**Mutation check.** Nine deliberate breakages, each reverted afterwards, were
all caught: session cookie not hardened (2 tests), proxy cookie not hardened
(1), duplicate `code` accepted (1), duplicate `sb_flow_id` accepted (1),
expired provider code ignored (1), route dropping `error_code` (1),
`signup_disabled` enumerating (1), and a server action trusting its argument
(3). A first attempt at the last one changed only a type and failed nothing,
which is why it was redone as a behavioural mutation.

### Commands run

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`: passed
- `pnpm test`: passed, 18 files, 366 tests
- `pnpm test:integration`: passed, 2 files, 25 tests
- `pnpm test:security`: passed, 10 files, 212 tests
- `pnpm build`: passed; `/auth/callback` and `/dashboard` are dynamic routes,
  and a case-sensitive search of `.next/` found neither placeholder key
- End to end through `next start -p 3100`, with `SUPABASE_URL` pointing at a
  scratch HTTP stub of the auth endpoints (not committed):
  - callback with no verifier: `303` to `/sign-in?error=link_other_browser`
  - callback with the verifier: `303` to `/dashboard`, and
    `set-cookie: sb-127-auth-token=...; Secure; HttpOnly; SameSite=lax`
  - that cookie renders `/dashboard` (200, `<h1>Dashboard</h1>`)
  - replayed code: `link_invalid`; duplicate `code`: `link_invalid`;
    `error_code=otp_expired`: `link_expired`
  - the server log contained neither the auth code nor the verifier

Not run: anything against a real Supabase instance (TASK-003b, and Docker is
still broken on this machine).

### Remaining concerns

- **Not proven without real Supabase:** real GoTrue status codes for used,
  expired and unknown codes; token rotation; chunked cookies for large
  sessions; and the actual magic-link email. The stub models what auth-js
  needs, not GoTrue's full behaviour.
- **Harness fidelity:** expired PKCE codes in the stub are infinitely
  replayable and answer `403`, where GoTrue's status may differ. Worth
  tightening when TASK-003b lands real coverage.
- **No application-level rate limit** on magic-link requests: an
  unauthenticated caller can ask for mail to arbitrary addresses, bounded only
  by Supabase's own limits. Phase 6 owns rate limiting, and `.ai/PLAN.md` says
  Phase 1 adopts it retroactively.
- **Google sign-in needs JavaScript.** Without it, the form POST redirect to
  Google is blocked by `form-action 'self'`. Widening the CSP is a decision for
  the project owner.
- **Concurrent sign-ins in several tabs** can exchange the wrong verifier
  unless auth-js's experimental `appendPkceFlowIdToRedirects` is enabled, which
  changes a TASK-001 file.
- **TASK-003b is a draft** and needs approval before local Supabase or the CI
  job exists.
