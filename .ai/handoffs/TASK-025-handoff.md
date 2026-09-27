## Handoff

### Summary

The scheduled verifier (TASK-025), which closes Phase 7: a cron route
authenticated by `CRON_SECRET`, a queue of the deployments due for a check in
the current window, and one `verification_checks` row for each deployment the
run reaches — composing TASK-023's fetch with TASK-024's inspection.

**This is the task the last three were written for.** Nothing had ever written a
row to `verification_checks` until now.

**This pull request contains a migration.** Supabase's "Deploy to production"
applies it on merge. It is additive: one function and one grant. No table,
column, constraint, policy or existing grant is touched.

**Nothing schedules the route.** There is no `vercel.json` and no cron entry
(owner, 2026-09-27): merging this must not be the act that starts fetching real
customer sites. To begin verification, add an hourly schedule against
`GET /api/cron/verify`; README §18 says why hourly against a daily window.

### Decisions

Owner, 2026-09-27.

1. **A check window is one day.** The storage decision PR #39 note 1 deferred to
   this task: evidence is never pruned, and `unique (deployment_id,
check_window)` fixes the rate at one row per active deployment per window.
   Daily is 365 rows a year against hourly's 8 760. Cost: a notice can be absent
   for most of a day before any row says so, so the evidence supports _checked
   daily_ rather than _continuously monitored_ — README §18 now states the
   weaker claim, and §72 already forbade the stronger one.
2. **One invocation does a bounded batch under a wall-clock budget.** A run that
   stops early leaves the deployments it did not reach with no row for the
   window, which is the queue's definition of work to do; a run that dies
   mid-flight leaves work nobody can see. Cost: the schedule has to tick more
   often than the window.
3. **One in-flight fetch per hostname**, on top of the concurrency cap — the
   per-host limit this phase has owed since TASK-023. Fifty simultaneous
   requests from our addresses is a burst a host may treat as an attack, and its
   429 would be recorded as that customer's `HTTP_ERROR`. Cost: a customer with
   many deployments on one host is checked more slowly.
4. **The route ships; the schedule does not.** Cost: the deployed state does not
   match the repository until somebody adds the schedule, so it is written here
   and in README §18.

Implementer: thirteen proposals, awaiting sign-off. The queue as a SQL function
rather than a query builder, reusing the predicate `public.public_disclosure`
already applies; the window and the schedule as separate things, with the
schedule ticking more often; the queue as the only state — no claim, no lease,
no cursor; a failure row taking a deployment out of the queue while a fault of
ours does not; `CRON_SECRET` compared as SHA-256 digests; `Authorization: Bearer`
and never a query parameter; `GET` with a side effect, deliberately; counts and
never hostnames in the response; the run as a pure function of a batch plus three
injected capabilities; the time budget taken from the fetch's own bound;
`payload_hash`, `previous_record_hash` and `disclosure_version` all left null;
`check_window` from the run's clock and `checked_at` from the database's, with no
backfill; and UTC midnight as the boundary. The contract states each one's
reason and what was rejected.

### Files changed

- `.ai/tasks/TASK-025-verification-scheduler.md` (new): the contract
- `supabase/migrations/20260927160000_verification_queue.sql` (new): the queue
  function, service role only
- `features/verification/check-window.ts` (new): the window, and why its length
  is the storage policy
- `features/verification/verification-queries.ts` (new): the two database calls
- `features/verification/run-verification.ts` (new): the batch, the budget, the
  per-host chains, the catch
- `lib/security/cron-auth.ts` (new): the secret comparison
- `app/api/cron/verify/route.ts` (new): the route
- `supabase/tests/verification_queue.test.sql` (new): 14 assertions
- `tests/unit/verification/check-window.test.ts` (new)
- `tests/unit/verification/run-verification.test.ts` (new)
- `tests/security/verification/cron-auth.test.ts` (new)
- `tests/integration/verification/scheduler.supabase.ts` (new)
- `README.md` §18; `.ai/PLAN.md` Phase 7

### Security considerations

- **The secret is compared as digests, in constant time.** Both sides hashed,
  then `timingSafeEqual` over two 32-byte buffers. Comparing the raw values
  would need a length check in front of `timingSafeEqual`, and a length check
  before a constant-time comparison tells an attacker how long the secret is. A
  test proves the hashing is really there: without it, a header of a different
  length would throw a `RangeError` rather than return false.
- **Only the `Authorization` header.** A secret in a query string is a secret in
  an access log, in browser history and in a `Referer` (§16), so a `?secret=`
  parameter is refused even when present. A test asserts it.
- **The scheme is matched case-insensitively.** RFC 7235 makes it
  case-insensitive; refusing `bearer` would mean a verifier that silently never
  runs. Only what follows the scheme is secret.
- **The queue function is executable by `service_role` alone.** It crosses every
  tenant boundary by design — that is what a scheduler needs and exactly why no
  signed-in or anonymous caller may call it. Proven twice: by grant in pgTAP, and
  through PostgREST with the anon key in the integration suite.
- **A member still cannot write evidence about themselves.** TASK-022 gave
  `authenticated` no insert grant; restated as a test here because this is the
  task that starts writing.
- **A fault of ours is never recorded as a customer's failed check.** The fetch
  and the inspection reject only when the fault is ours, and the run writes no
  row for those, logs which hostname it was, and leaves the deployment in the
  queue for the next tick (PR #40 note 4). Proven in both the unit and the
  real-database suites, the latter by asserting the row count is zero and the
  deployment is still due.
- **One deployment's failure never stops the run.** Everything per-deployment is
  caught and counted, including a database refusal.
- **Nothing about which customers failed leaves in the HTTP response.** Counts
  only. A scheduler's dashboard stores response bodies.
- **The database's clock times the evidence.** `checked_at` is not sent;
  TASK-022's trigger sets it. The integration suite asserts the written
  `checked_at` is the database's and not the run's.
- **No backfill.** A late or skipped tick writes for the window it is in. A row
  for a window nobody observed would be manufactured evidence.

### Verification

```
pnpm typecheck                      pass (app and widget projects)
pnpm lint                           pass
pnpm format:check                   pass
pnpm test                           pass — 74 files, 2013 tests
pgTAP (supabase test db --local)    pass — 10 files, 343 tests
real-database vitest                pass — 35 files, 421 tests
Playwright (browser suite)          pass — 31 tests
next build                          pass — compiled successfully
```

The database was reset to the migration head before the database suites and
again before the browser suite; the new function applied cleanly.
`CODEX-SECURITY.md`'s sha256 was checked before and after Prettier: unchanged,
and Prettier was run on changed files by name rather than across the tree.

### Three things the tests found, all of them mine

- **A log field collided with pino's own.** The run logged the customer's host
  as `hostname`, which pino already puts on every record as the _machine's_
  name — so the line came out with two keys of that name and one of them would
  be dropped by a reader or a log pipeline. PR #40 note 4 requires the
  scheduler to log which hostname it was, so the collision would have quietly
  defeated the requirement. It is `targetHostname` now, with a test asserting
  the key survives and that `hostname` is not ours.
- **A pgTAP fixture assumed a notice can be turned off by an update.** A
  published disclosure version is wholly immutable, so turning a notice off is
  publishing a new version with `enabled = false`. The fixture does that now,
  which is also the stronger test: it proves the queue reads the _current_
  version's flag rather than any enabled version the system ever had.
- **The integration suite's window was in the future.** `check (check_window <=
checked_at)` refuses a window that begins after the check happened, so every
  write failed. The constraint was right and the test was wrong.

### Before merging

- **This migration runs on merge.** One function created, one grant. It reads
  four tables the service role can already read, so it grants no new access.
- **Nothing runs on a schedule.** The route exists and nothing calls it until an
  operator adds a cron entry. That is the deliberate seam in this pull request.
- **The application's behaviour is otherwise unchanged.** No existing route,
  screen or query is touched.

### Remaining concerns

- **The first real run is unwatched by definition.** It will make outbound
  requests to real customer hostnames for the first time. Worth enabling the
  schedule while somebody is looking at the logs, and worth knowing that
  `errored` above zero in `verification_run_finished` means a bug of ours rather
  than a customer's failure.
- **§20's hash chain now has a growing gap.** The columns exist, nothing writes
  them, and this task's first run starts collecting evidence the chain will not
  cover. README §20 says so; the ordering question — what "previous record"
  means across deployments — is still open.
- **§18's fourth question stays unanswered.** `DISCLOSURE_VERSION_MISMATCH` is
  emitted by nothing and `disclosure_version` is null in every row, because HTML
  inspection cannot observe a version (TASK-024). A stale notice reads as a
  current one.
- **No alerting on a run that stops happening.** The route reports what it did,
  and nothing notices if it is never called. Phase 12 owns alerting; until then
  the absence of rows is the only signal, and nobody is watching for it.
- **The batch and budget numbers are guesses at this scale.** 200, four at a
  time, fifty seconds. They are module constants, and the first production run
  is what should inform them.
- **Owed, unchanged:** `learnMoreUrl` as a whole; a cache purge on publish; a
  hard ceiling at the edge if the public endpoint's alert fires; key rotation
  plus `git stash drop`; stale-save protection on the AI system edit form; a
  member directory if a publisher is ever to be named; the TASK-010 to TASK-021
  sign-offs.
