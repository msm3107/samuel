## Handoff

### Summary

Fixes from the independent review of PRs #9–#11, and the project owner's
decisions of 2026-09-19.

| Review item                                             | Outcome                                                               |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| A whole office shares one magic-link limit              | Past 5 per 10 min: challenge. Past 30: refused (owner's decision)     |
| Google start and callback limits too low for shared IPs | Raised to 30 and 60 per 10 min (my decision, for review)              |
| No total on callback exchanges across networks          | Service-wide ceiling: 40 per 5 min                                    |
| The limiter's database call had no timeout              | 2 seconds, then `unavailable`                                         |
| No challenge after sign-out (in-app navigation)         | Cloudflare's frame allowed on every page                              |
| Error-level log volume decided by an attacker           | At most one entry per 5 minutes, for each alert                       |
| Off Vercel, every visitor shares one bucket             | Production refuses to start off loopback without `VERCEL=1`           |
| CRLF files and a NUL byte hid diffs from review         | `.gitattributes` (LF), two files re-normalized, NUL written as escape |
| Two residual risks not accepted by the owner            | Both marked `Accepted by msm3107 (project owner), 2026-09-19`         |
| Production auth settings not recorded                   | `docs/production-setup.md`                                            |
| F2 still open for server actions and route handlers     | TASK-003i contract; TASK-007 now depends on it                        |
| Sessions never end in production on the free plan       | Owner chose in-app enforcement: TASK-003h, next                       |
| `main` unprotected                                      | Branch protection set (owner-approved): four checks, admins included  |

### How GoTrue counts the callback (read from its source)

`internal/api/token.go`: the `pkce`, `refresh_token` and `password` grants
all use `limiterOpts.Token`, one bucket per client IP (`token_refresh`, 150
per 5 minutes by default). Every such request comes from this application's
servers, so the callback ceiling (40) and TASK-003f's refresh ceiling (100)
are set to keep the total under 150. Past the callback ceiling the answer is
`sign_in_unavailable`, not `rate_limited`, which would blame the visitor's
network.

### Files changed

- `lib/security/rate-limit.ts`: new limits (`magicLinkNetworkCap`,
  `magicLinkThresholdAlert`, `callbackGlobal`, `callbackCeilingAlert`), raised
  Google and callback limits, `RATE_LIMIT_TIMEOUT_MS`
- `lib/auth/sign-in/magic-link-gate.ts`, `complete-sign-in.ts`
- `proxy.ts`: `frame-src https://challenges.cloudflare.com` on every page
- `lib/env/server-env.ts`: `VERCEL` required in production off loopback
- `.gitattributes`; `.env.example` and `supabase/config.toml` re-normalized
  (line endings only: `git diff --ignore-cr-at-eol` shows nothing)
- `tests/unit/auth/sign-in-inputs.test.ts`: the NUL byte written as
  `\u0000`; the string's value is unchanged
- `docs/production-setup.md` (new)
- `.ai/tasks/`: TASK-003g (new), TASK-003i (new), TASK-003c (acceptances),
  TASK-007 (depends on 003i)
- Tests: see below

### Tests

- security: a busy network gets the challenge, spends no global allowance,
  and gets through with a solved challenge; past the cap it is refused at
  once, even with a solved challenge, without calling Cloudflare; the
  callback ceiling makes no GoTrue call; the threshold alert is logged once
  across three requests; every page's CSP allows the frame and no script host
- unit: a hung limiter call is abandoned after 2 seconds as unavailable;
  `VERCEL` is required in production off loopback and not on loopback; the
  limits table
- e2e: past the threshold, sign in, sign out, request again: the widget
  appears and the link is sent, with no CSP violations
- **Mutation check:** 6 mutants (no cap, busy network refused, alert every
  time, no callback ceiling, no timeout, `VERCEL` not required), all caught.
  The e2e sign-out test fails against the old "/sign-in only" frame rule
  (the widget never produces a token). Every file restored, hash-checked.

### Commands run

- `pnpm typecheck`, `pnpm lint`: passed
- `pnpm format:check`: passed (with the owner's untracked
  `CODEX-SECURITY.md` set aside)
- `pnpm test`: 535 passed
- `pnpm test:integration`: 26 passed
- `pnpm test:security`: 273 passed
- `pnpm build`: passed with CI's placeholder environment
- `pnpm test:e2e`: 18 passed

**Not run locally:** the real-Supabase suites (Docker is down); the pull
request's End-to-end job runs them.

### Remaining concerns

- **Owner review of my choices:** Google start and the callback raised to 30
  and 60 per network; the callback ceiling of 40 per 5 minutes, which caps
  completed sign-ins at about 480 an hour until the hosted token limit is
  raised.
- **TASK-003h** (in-app 7-day limit), **TASK-003f** (refresh limit, with its
  100 per 5 minutes ceiling) and **TASK-003i** follow, in that order.
