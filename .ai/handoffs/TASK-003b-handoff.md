## Handoff

### Summary

Local Supabase is configured and proven. The sign-in flow now runs end to end
against a real local instance, both from Vitest and in a real browser, and a
new `End-to-end` CI workflow runs all of it on every pull request.

This closes Phase 1's exit criterion "sign-in works end to end against a local
Supabase instance".

It also found and fixed a real **account-enumeration timing leak** that the
stub-based suites could not see (below).

Branch `feat/local-supabase-e2e`, off `main` after PRs #2–#5 merged. It carries
two documentation commits made earlier: TASK-003b marked approved with the
TASK-003c contract, and the Codex reviewer handoff in `AGENTS.md`.

### The timing leak, and the fix

The new enumeration test measures what real GoTrue does for registered and
unregistered addresses:

| Address      | Median response |
| ------------ | --------------- |
| registered   | 44 ms           |
| unregistered | 141 ms          |

The numbers were stable across three runs, and the two groups never overlapped.
Creating a user costs GoTrue about 100 ms more, so anyone timing the
magic-link request could tell which addresses have accounts, even though the
screen answers identically.

The fix is `lib/auth/sign-in/response-floor.ts`. The server action now holds
every magic-link answer to a fixed floor of 1200 ms plus up to 200 ms of random
jitter, including when the work fails.

- If real work ever takes longer than the floor, it logs
  `magic_link_response_floor_exceeded`, because the gap would be visible again.
- The floor is in the server action rather than the core function, because the
  action is what a visitor's request reaches.
- Through the action, the enumeration test now passes: identical result codes,
  every address receives mail, and the medians are within the asserted ratio.
- Before the fix, the same test failed at a 3.2× ratio.

Two alternatives were rejected:

- **Sending after the response** (Next.js `after()`). The PKCE verifier cookie
  is written during `signInWithOtp` and cannot be set once the response is
  gone, so every link would fail as "opened in another browser".
- **Padding in `requestMagicLink` itself.** That would slow every stub-based
  test that calls it, and it is not what an attacker times.

A residual gap remains if hosted SMTP is ever slower than the floor. TASK-003c's
per-address and per-IP limits then cap how many samples an attacker can take.

### Files changed

- supabase/config.toml (new, from `supabase init`, then tailored), and
  supabase/.gitignore (new, from init)
- scripts/local-env.mjs (new)
- vitest.supabase.config.ts (new)
- tests/supabase/support/: require-local-supabase.ts, mailpit.ts,
  session-cookies.ts (new)
- tests/supabase/auth/sign-in.supabase.ts, enumeration.supabase.ts (new)
- tests/e2e/auth/sign-in.supabase.spec.ts (new)
- tests/e2e/auth/support/start-e2e-app.mjs (gains a `--supabase` mode)
- playwright.config.ts (ignores `*.supabase.spec.ts`), and
  playwright.supabase.config.ts (new)
- .github/workflows/e2e.yml (new)
- package.json, pnpm-lock.yaml: `supabase` 2.117.0 pinned; `supabase:start`,
  `supabase:stop`, `test:supabase` and `test:e2e:supabase` scripts
- lib/auth/sign-in/response-floor.ts (new), lib/auth/sign-in/actions.ts
  (timing fix, recorded as an amendment)
- tests/unit/auth/response-floor.test.ts (new)
- CONTRIBUTING.md (local setup), .env.example (one comment)
- .ai/tasks/TASK-003b-\*.md (amendments), this handoff

`ci.yml`, `security.yml`, `vitest.config.ts` and `lib/database/` are unchanged.

### `config.toml` choices

- **Redirects.** `site_url` is `http://localhost:3000`. The redirect allowlist
  lists exact URLs, with no wildcards: `/auth/callback` on `localhost:3000`,
  `127.0.0.1:3000` and `localhost:3220` (the real-Supabase browser suite).
  Security review showed that GoTrue additionally accepts **any URL on
  `site_url`'s host** (any port and path), while refusing other hosts and
  look-alikes such as `localhost.evil.example`. So the list is not strictly
  exact, and in production `site_url` must be a host that serves nothing an
  attacker controls. PKCE still requires the verifier cookie on whatever URL
  receives the code.
- **Per-address resend throttle** (`auth.email.max_frequency`): 60 s.
- **Local rate limits,** set explicitly and raised so the suites, which all run
  from one IP, fit in one window. The hosted project sets its own values.
  - `email_sent`: 300 per hour
  - `sign_in_sign_ups`: 150 per 5 minutes
  - `token_verifications`: 150 per 5 minutes
  - `token_refresh`: left at the default, 150 per 5 minutes
- **Google** is read from `env()` and `enabled = false`. No credentials are
  committed.
- **`project_id`** is `article50`.
- **Local only.** A header comment forbids `supabase config push`, which would
  hand a hosted project these localhost URLs and raised limits.

### Security considerations

- **Only local.** The real-Supabase suites refuse to start unless
  `SUPABASE_URL` is `127.0.0.1` or `localhost`. No hosted project is linked.
- **No keys committed.** `scripts/local-env.mjs` reads URLs and keys from
  `supabase status` at run time. The keys are Supabase's published local
  development keys. `--write` never overwrites an existing `.env.local`.
- **No shell.** `--exec` runs only `node <script>` and never goes through a
  shell, so arguments are never joined unquoted.
- **Default suite unchanged.** `pnpm test`, `ci.yml` and `security.yml` still
  need no Supabase. Real-Supabase files are named `*.supabase.ts` and are
  excluded by the default include pattern.
- **The e2e app** still inherits only what Node needs, and binds to localhost.

### Tests

Security review: `APPROVE WITH NON-BLOCKING NOTES`. Contract review:
`APPROVE WITH NON-BLOCKING NOTES`. Their notes are either fixed on this branch
or listed under Remaining concerns.

Real-Supabase Vitest (`pnpm test:supabase`), 5 tests:

- a magic link delivered to Mailpit, followed, and exchanged by the real
  callback; `requireSession()` returns the id GoTrue assigned
- the same link opened twice is refused, first by GoTrue itself (no new
  code, only an error) and then by the callback
- a session revoked on the auth server (`logout?scope=global`) is rejected
  while its access token is still unexpired
- the proxy refreshes an expired access token and writes an `HttpOnly` cookie
- registered and unregistered addresses get the same code, all receive mail,
  and their median times through the action are comparable

Real-Supabase Playwright (`pnpm test:e2e:supabase`), 3 tests:

- the full sign-in in a browser: request a link on the screen, read it from
  Mailpit, open it, land on the dashboard, with every session cookie
  `HttpOnly`
- the link opened in a different browser context is refused with the
  same-browser message
- once the cookies are gone, the dashboard sends the visitor to sign-in

Unit: 4 tests for the response floor using an injected clock, covering
padding, equal finish times for fast and slow paths, padding on failure, and
the log when the floor is exceeded.

### Commands run

- `pnpm typecheck`, `pnpm lint`: passed
- `pnpm format:check`: passed for every file on this branch. It fails only on
  the untracked `CODEX-SECURITY.md`, which is not part of this change.
- `pnpm test`: 382 passed
- `pnpm test:supabase`: 5 passed (and the enumeration test failed at a 3.2×
  ratio before the fix)
- `pnpm test:e2e`: 13 passed, including the response floor's added latency
- `pnpm test:e2e:supabase`: 3 passed
- `pnpm supabase:start`, `pnpm supabase:stop`: work. The first run pulls
  images.
- `supabase db reset`: succeeded (it applies the migrations, of which there
  are none yet, and the seed). The real-Supabase suites passed again afterwards.
- On PR #6, the new `End-to-end` workflow passed in 3 min 17 s, alongside CI,
  the security suite and the dependency audit.

After review:

- A mistyped `local-env.mjs` mode now prints usage and exits 1.
- The enumeration test also fails if any request outlasts the floor. Lowering
  the floor to 10 ms fails it; restoring the floor passes it.

### Remaining concerns

- **CI cost.** The `End-to-end` job adds about 3.5 minutes per run.
- **Whether `End-to-end` becomes a required check** on `main` is a repository
  setting for the project owner.
- **The response floor adds about 1.3 s** to every magic-link request. That's
  acceptable for "email me a link", but it is a visible cost.
- **Hosted SMTP may be slower than the floor.** If
  `magic_link_response_floor_exceeded` appears, the floor needs raising, or the
  sending needs to move off the request path in some way that keeps the PKCE
  cookie.
- **Docker Desktop on Windows** needs Docker AI turned off (see
  `CONTRIBUTING.md`); its socket crashed the app repeatedly.
- **The response floor holds every request for about 1.3 s,** including
  invalid input, with no rate limit yet. On serverless hosting that is billed
  wall time an attacker can drive. TASK-003c's contract now requires per-IP and
  global limits before the floor, and account-independent rejections answered
  without it.
- **`magic_link_response_floor_exceeded` should alert, not just log,**
  because it means the timing gap is visible again. That's Phase 12
  (observability).
- **Direct calls to GoTrue skip the floor.** Today the anon key is read only
  server-side. If it is ever published to browsers, anyone could time
  `/auth/v1/otp` directly and see the 3× gap.
- **Workflow actions are pinned to major tags,** not commit SHAs. This matches
  the existing `ci.yml` and `security.yml`; pinning all three is a
  supply-chain follow-up.
- **The local stack listens on all interfaces** (Supabase CLI default), which
  `CONTRIBUTING.md` now warns about.
- **TASK-003c** (application rate limits) is next and uses this local instance
  for its migration.
