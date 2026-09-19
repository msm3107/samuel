## Handoff

### Summary

The application now enforces its own sign-in rate limits, checked before any
call to Supabase Auth. Past a global threshold, the magic-link form asks for a
Cloudflare Turnstile challenge instead of refusing everyone.

| Entry point          | Limit                                         | Over the limit                    |
| -------------------- | --------------------------------------------- | --------------------------------- |
| Magic link           | 5 per 10 min per client network               | `rate_limited`, at once           |
| Magic link           | 200 per hour across the service               | Turnstile challenge, and an alert |
| Magic link           | 3 per 10 min per address, at least 60 s apart | `link_sent`, inside the floor     |
| Google sign-in start | 10 per 10 min per client network              | `/sign-in?error=rate_limited`     |
| Callback exchange    | 20 per 10 min per client network              | `/sign-in?error=rate_limited`     |

The session-refresh limit was split into TASK-003f (proxy changes, reviewed
on their own); its contract is on this branch.

### Design decisions (recorded in the contract's 2026-09-18 amendment)

- **The application verifies Turnstile tokens, not GoTrue.** GoTrue's own
  CAPTCHA check is all or nothing; the approved design challenges only past
  the threshold. The anon key is server-only, so GoTrue cannot be called
  around the application.
- **Cloudflare's test keys do not answer as documented.** Observed
  2026-09-19: siteverify answers the test secret with hostname
  `example.com`, no action, and `metadata.result_with_testing_key: true`
  (the docs say `localhost` and `test`). With a test secret, only that flag is
  checked. With a real secret, hostname and action are checked and a
  test-key answer is refused. Test keys are refused in production unless the
  app URL is loopback.
- **Client network:** `x-vercel-forwarded-for` only, and only when `VERCEL`
  is `1` (Vercel sets it, and unlike `x-forwarded-for` a proxy in front of
  Vercel cannot rewrite it). IPv4 addresses whole, IPv6 by /64,
  IPv4-mapped IPv6 as IPv4. Elsewhere every request shares one bucket.

### Files changed

- `supabase/migrations/20260918120000_rate_limits.sql`: table
  `private.rate_limits` (schema not exposed by the Data API, RLS on, no
  grants), `public.consume_rate_limit` (`security definer`, `search_path = ''`,
  execute for `service_role` only), daily `pg_cron` cleanup
- `lib/security/rate-limit.ts`, `client-ip.ts`, `turnstile.ts`
- `lib/auth/sign-in/magic-link-gate.ts` (new), `request-magic-link.ts`,
  `start-google-sign-in.ts`, `complete-sign-in.ts`, `actions.ts`,
  `result-codes.ts`
- `app/(auth)/auth/callback/route.ts`, `app/(auth)/sign-in/page.tsx`,
  `sign-in-messages.ts`
- `components/forms/magic-link-form.tsx`, `turnstile-widget.tsx` (new)
- `proxy.ts`: `frame-src https://challenges.cloudflare.com` on `/sign-in` only
- `lib/env/server-env.ts`, `.env.example`, `scripts/local-env.mjs`,
  `tests/setup-test-env.ts`, `.github/workflows/ci.yml` (placeholders and
  Cloudflare's published test keys only)
- `playwright.config.ts`: a `challenge` project that runs after the others
- `README.md` §34: the privacy notice
- Tests: see below

Scope additions made to the contract while working, each for a file the
change could not avoid: `tests/unit/auth/**` (a test pins the list of
callback error codes), `tests/setup-test-env.ts` (the new required
variables), `playwright.config.ts` and `playwright.supabase.config.ts` (the
challenge project, and keeping it out of the real-Supabase run).

### Security considerations

- Every limited path consumes its limit before any Supabase Auth call. If the
  limiter or Cloudflare cannot answer, the request is refused as unavailable.
- Refusals that depend only on the request (format, network, threshold)
  answer at once; everything that depends on the address stays inside the
  1200 ms response floor, including the per-address limit, which answers
  `link_sent` exactly as a sent link does.
- The database stores only HMAC-SHA256 digests (the table's check constraint
  refuses anything else). No address or IP is sent to the database, logged,
  or sent to Cloudflare.
- Only `/sign-in` may frame Cloudflare; `script-src` is unchanged.
- **Residual risk:** someone who knows an address can spend its per-address
  allowance and hold back that person's magic links for up to 10 minutes.
  Google sign-in stays available; the hits are logged for alerting.
- **Residual risk, for the project owner to judge:** a per-address-limited
  request starts no PKCE flow, so its response sets no verifier cookie where a
  sent link's does. That tells a requester a link was asked for that address
  within the last few minutes, never whether an account exists. A decoy
  cookie would have to rewrite auth-js's flow index and could evict a pending
  link's verifier, which is what the limit protects. Recorded in the contract.

### Tests

- **unit** (`tests/unit/security/`, 60): HMAC keys never contain the raw
  value and depend on the secret and scope; the database call's shape, key
  and failure handling; client-network resolution and IPv6 /64 grouping;
  Turnstile verification, including every fail-closed case. Env: the new
  variables are required, and test keys are refused in production off
  loopback.
- **security** (`tests/security/rate-limit/`, 22): every limited path makes
  zero Supabase Auth calls; the per-address limit gives the sent-link result
  within the same floor; the limiter and Cloudflare fail closed;
  one IPv6 /64 shares a bucket; no address or IP reaches the database or the
  logs; the challenge replaces a refusal past the threshold.
  `tests/security/headers/turnstile-csp.test.ts` (6): the CSP change is
  confined to `/sign-in`.
- **Mutation check:** 11 mutants of the wiring (each check removed or
  inverted, IPv6 keyed whole, headers trusted off Vercel, refusals held to the
  floor); all 11 caught, and every file restored (hash-checked).
- **SQL:** the migration's function and grants were exercised in PGlite
  (17 checks: counting, refusals not counted, window reset, spacing across a
  window reset, parameter and key validation, anon and authenticated denied,
  service role allowed but unable to read the table). Not concurrency, and
  not `pg_cron`.
- **e2e** (`tests/e2e/auth/turnstile.challenge.spec.ts`, 2): the real
  widget under the real CSP with Cloudflare's always-pass key, verified by
  Cloudflare's real siteverify, then the link is sent; the challenge comes
  before the submit button in tab order. `sign-in.spec.ts`: an ordinary sign-in
  contacts no Cloudflare host.
- **supabase** (`tests/supabase/rate-limit/rate-limit.supabase.ts`, 6):
  concurrency (20 at once against a limit of 5), spacing, window reset,
  non-digest keys refused, anon and authenticated cannot call the function or
  read the table. `sign-in.supabase.ts`: the same-address retry that moved
  here from TASK-003d.
- `enumeration.supabase.ts` now times the floor around `requestMagicLink`
  (what the action runs once the gate passes) instead of the whole action:
  its 16 requests would otherwise exceed the shared local network's 5 per
  10 minutes, and the gate never looks at the address.

### Pre-PR review

Three independent reviewers (security, contract, accessibility) and an
adversarial verifier: 10 findings, 6 confirmed, 4 rejected with reasons.

- Fixed: the base Playwright projects leaked into
  `playwright.supabase.config.ts`, which would have run the stub-only
  challenge spec against real Supabase and silently dropped the real-Supabase
  browser spec (blocker; `--list` now shows 17 and 3 tests).
- Fixed: `playwright.config.ts` was edited without being in the contract.
- Fixed: a Turnstile failure was not announced and could not be reached by
  keyboard; it is now an alert, and a retry that succeeds clears it.
- Fixed: the challenge copy said "below" for a check shown above it.
- Accepted and recorded: the verifier-cookie difference above.
- Also strengthened, from rejected findings: timing assertions on the
  challenge-failure paths, and the exact 5-second Cloudflare timeout.

### Commands run

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`: passed (with the owner's
  untracked `CODEX-SECURITY.md` set aside)
- `pnpm test`: 528 passed (after rebasing onto #9 and #10)
- `pnpm test:integration`: 26 passed
- `pnpm test:security`: 270 passed
- `pnpm build`: passed with CI's placeholder environment
- `pnpm test:e2e`: 17 passed, including the Turnstile challenge against
  Cloudflare

**Not run locally:** `pnpm test:supabase` and `pnpm test:e2e:supabase`,
because Docker Desktop is still down. The migration has not been applied to a
real Postgres here. The PR's End-to-end job runs both.

### Remaining concerns

- **Production settings (the project owner's):** a real Turnstile widget
  (site key and secret, with the production hostname), and
  `RATE_LIMIT_HMAC_SECRET` in Vercel. `pg_cron` must be available on the
  hosted project (it is on Supabase).
- **Alerting (Phase 12):** `magic_link_global_threshold_exceeded` (error
  level) and repeated `rate_limited` with `limit: "magicLinkAddress"`.
- **GoTrue still counts every server-side request against this app's own IP**
  on the hosted project; its limits must stay above these.
