## Handoff

### Summary

Sessions now end 7 days after their last sign-in whatever the hosted Supabase
plan. Hosted Supabase applies `sessions.timebox` only on a paid plan with the
setting applied, so production sessions ended only at sign-out; the 7-day
cookie cap (TASK-003e) is renewed by every refresh and does not bound an
active session. The project owner chose in-app enforcement on 2026-09-19,
after the review of PRs #9–#11.

Stacked on `fix/rate-limit-review-follow-ups` (PR #12), which its test
harnesses depend on.

### How it works

- `resolveSessionUser` now reads the session with `getSession()` (which
  refreshes an expired access token), validates **that exact token** with
  `getUser(jwt)`, and only then reads the token's own claims. Nothing is
  decoded before the auth server has accepted it.
- `lib/auth/session-age.ts` reads the `amr` claim: GoTrue lists each
  authentication method used in the session with the time it was last used
  (`Session.CalculateAALAndAMR`, `internal/models/sessions.go`), and a refresh
  adds no entry, so the newest timestamp is the session's last real sign-in.
- Past 7 days the resolution is `unauthenticated` with the new code
  `session_expired`: the proxy redirects dashboard requests to sign-in and
  `requireSession` throws, both through paths that already existed.
- A token with no readable `amr` counts as expired, so a session can never
  outlive the claim it is judged by.

### Files changed

- `lib/auth/session-age.ts` (new), `lib/auth/resolve-session-user.ts`,
  `lib/auth/errors.ts`
- `tests/security/auth/support/stub-auth-server.ts` and
  `tests/e2e/auth/support/stub-auth-server.mjs`: stub access tokens are now
  JWT-shaped with an `amr` claim, as GoTrue's are
- `tests/unit/auth/session-age.test.ts` (new),
  `tests/security/auth/expired-session.test.ts`,
  `tests/supabase/auth/sign-in.supabase.ts`
- `.ai/tasks/TASK-003h-in-app-session-limit.md`

### Security considerations

- The claim is read from a token the auth server has just accepted, never
  from the cookie's contents; `getSession()` alone decides nothing.
- Failing closed on an unreadable `amr` means a GoTrue change that dropped the
  claim would sign everyone out rather than leave sessions unbounded. The
  real-Supabase test is what would catch that first.
- No new auth-server round trip: `getUser(jwt)` replaces `getUser()`.
- The idle limit (24 hours) still exists only in hosted Supabase's settings.

### Tests

- **unit** (`tests/unit/auth/session-age.test.ts`, 14): the newest timestamp
  wins whatever the order; the boundary at exactly 7 days and one second
  past; future timestamps; several `amr` entries; missing, empty, string-form
  and malformed claims; opaque tokens.
- **security** (`tests/security/auth/expired-session.test.ts`, 6 new): a
  session older than 7 days whose token GoTrue still accepts is refused by
  `requireSession`, by the proxy and by the dashboard layout; one signed in 6
  days ago is accepted; a token with no sign-in time is refused; a refreshed
  aged session stays refused, so it cannot refresh its way past the limit.
- **supabase:** a real sign-in's `amr` timestamp is within two minutes of now
  and survives a refresh unchanged, with a new access token.
- **Mutation check:** 4 mutants (no age check, fail open on a missing claim,
  oldest instead of newest timestamp, limit doubled), all caught; files
  restored, hash-checked.

### Commands run

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`: passed (with the owner's
  untracked `CODEX-SECURITY.md` set aside)
- `pnpm test`: 574 passed
- `pnpm test:integration`: 26 passed
- `pnpm test:security`: 283 passed
- `pnpm test:e2e`: 18 passed

**Not run locally:** `pnpm test:supabase` and `pnpm test:e2e:supabase`, as
Docker is still down. The pull request's End-to-end job runs both, including
the new `amr` test.

### Remaining concerns

- **The hosted settings still matter** and stay in `docs/production-setup.md`:
  the 24-hour idle limit exists only there, and the hosted time-box remains
  defence in depth.
- **Re-authentication extends a session.** If a later phase adds a
  re-authentication step (GoTrue adds an `amr` entry), that moves the limit
  forward, which is the intended meaning of "7 days since you last proved who
  you are".
