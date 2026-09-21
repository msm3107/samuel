# TASK-003g — Rate-limit follow-ups from the review of PRs #9–#11

## Objective

Fix what the independent review of PRs #9–#11 found in the merged sign-in
rate limits, and apply the project owner's decisions of 2026-09-19.

## Owner agent

Backend, then Frontend for the challenge on in-app navigation.

## Dependencies

TASK-003c (merged in #11).

## Decisions (project owner, 2026-09-19)

- **Shared networks get a challenge, then a cap.** Offices, universities and
  mobile carriers put many people behind one address. Past 5 magic links per
  10 minutes, a network is asked for the Turnstile challenge instead of being
  refused; past 30 per 10 minutes it is refused.
- **Both TASK-003c residual risks are accepted** (recorded in that contract).

## Decisions made here, for the owner to review

- **Google start and the callback, per network:** raised from 10 and 20 to 30
  and 60 per 10 minutes. Neither can show a challenge (both are redirects), so
  the magic link's cap is the reference.
- **A service-wide ceiling on callback exchanges: 40 per 5 minutes.** GoTrue
  counts the code exchange, token refreshes and password grants in one bucket
  per client IP (`limiterOpts.Token` in `internal/api/token.go`; 150 per
  5 minutes by default), and every such request comes from this
  application's servers. Per-network limits have no total, so without a
  ceiling, many networks (for example many IPv6 /64s from one tunnel
  broker's /48) could spend that bucket and have real users' refreshes
  refused. 40 here plus TASK-003f's 100 for refreshes stays under 150. Past
  it, the callback answers `sign_in_unavailable`.

## Allowed files

- lib/security/rate-limit.ts, lib/security/client-ip.ts
- lib/auth/sign-in/\*\* (including flow-ticket.ts, new)
- lib/env/server-env.ts (`VERCEL` required in production off loopback)
- app/(auth)/sign-in/sign-in-messages.ts
- proxy.ts (`frame-src` on every page it serves)
- .gitattributes (new), and the line endings of files it re-normalizes
- tests/unit/auth/sign-in-inputs.test.ts (write its NUL byte as an escape)
- docs/production-setup.md (new: every setting production needs)
- .ai/tasks/TASK-003c-sign-in-rate-limiting.md (record the acceptances)
- .ai/tasks/TASK-003i-session-removal-outside-proxy.md (new contract),
  .ai/tasks/TASK-007-organization-creation.md (its dependency on 003i)
- tests/unit/\*\*, tests/security/\*\*, tests/e2e/auth/\*\*,
  tests/integration/auth/\*\*, tests/supabase/auth/\*\* (their cookie stubs
  gain `get`, which the flow ticket reads)

## Forbidden files

- supabase/migrations/\*\* (no schema change is needed)
- lib/database/\*\* (that is TASK-003i)

## Invariants

- **Checks before Supabase Auth, failing closed,** as in TASK-003c.
- **The limiter's database call has a 2-second timeout.** A timeout is
  `unavailable`, never a pass.
- **Magic-link order:** format; per-network cap (refuse); per-network soft
  limit (challenge); global threshold (challenge); then, inside the floor,
  the per-address limit.
- **Alert volume is bounded.** Past the global threshold, the error-level log
  is written at most once per 5 minutes; an attacker cannot fill the error
  log.
- **The challenge works after in-app navigation.** Every page the proxy
  serves allows Cloudflare's frame, because Next.js keeps the policy of the
  page a client-side navigation started from (sign-out and the dashboard's
  redirect both navigate to `/sign-in` that way). `script-src` is unchanged.
- **A callback proves a flow started here.** Sign-in paths that start a PKCE
  flow (a magic link, a Google redirect) issue a signed, HttpOnly flow ticket.
  The callback refuses anything without a valid, unexpired ticket
  (`link_other_browser`) before it spends any rate limit or calls Supabase
  Auth, and each ticket buys one exchange. Otherwise a flood of bare
  `/auth/callback?code=…` URLs — no cookie, no flow — could spend the
  service-wide ceiling below and refuse everyone's sign-in (found by the
  review of this task, 2026-09-19).
- **The ticket is not a credential.** It carries no identity and grants no
  access; the PKCE verifier still binds a code to one browser. It is issued
  on the per-address-limited path too, so that answer stays as
  indistinguishable from a sent link as it was.
- **Production runs on Vercel.** In production, off loopback, `VERCEL` must be
  `1`; otherwise every visitor would share one rate-limit bucket.

## Residual risk, for the project owner

Past the callback ceiling, new sign-ins are refused while signed-in people
keep working: the ceiling exists to reserve GoTrue's shared per-IP token
budget for refreshes. The flow ticket makes a free flood useless, but someone
willing to start a real flow per attempt from many networks (IPv6 /64s are
cheap) can still reach the ceiling and hold new sign-ins at
`sign_in_unavailable`. The alternative — no ceiling — lets the same attacker
exhaust GoTrue's bucket, which refuses refreshes too and takes signed-in
people's dashboards down with it. Needs an `Accepted by <owner>, <date>` or a
different instruction.

## Acceptance criteria

- An office network past 5 magic links in 10 minutes sees the challenge and
  can sign in; past 30 it is refused.
- Past 40 callback exchanges in 5 minutes across the service, a callback makes
  no GoTrue call.
- A callback without a valid flow ticket spends no rate limit and makes no
  GoTrue call; one ticket completes one exchange.
- A hung limiter answers `unavailable` within about 2 seconds.
- Signing out and then requesting a link past the threshold shows a working
  challenge without a reload.
- `git diff` of `.env.example` and `supabase/config.toml` shows real changes
  only, and GitHub shows `sign-in-inputs.test.ts` as text.
- Typecheck, lint, format, unit, security and e2e pass.

## Required tests

- security: soft network limit gives `captcha_required`, the cap gives
  `rate_limited`, both without Supabase Auth calls and without the floor
- security: the callback ceiling refuses without a GoTrue call, and its alert
  is logged once per window
- security: callbacks without a ticket, and with a forged ticket, spend
  nothing and call no GoTrue; a replayed ticket value is refused
- unit: the ticket's signature, age, shape and single use
- security: the threshold alert is logged once per window, not per request
- unit: the limiter times out as unavailable; `VERCEL` is required in
  production off loopback
- security: every page's CSP allows the Turnstile frame and no script host
- e2e: sign out, then request a link past the threshold: the widget appears
  and the link is sent
