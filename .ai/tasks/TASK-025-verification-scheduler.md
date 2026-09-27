# TASK-025 — The scheduled verifier

## Objective

Run the checks and write the evidence. A cron route authenticated by
`CRON_SECRET`, a queue of deployments due for a check in the current window,
and one `verification_checks` row per deployment it reaches — composing
TASK-023's fetch with TASK-024's inspection.

This is the task the last three were written for: nothing has written a row to
`verification_checks` until now.

## Owner agent

Backend

## Dependencies

TASK-011 (`deployments`, its hostname), TASK-016/TASK-017 (`disclosures`, and
what "published and enabled" means), TASK-019 (`public.public_disclosure` — the
predicate this task's queue reuses), TASK-022 (`verification_checks`, its
constraints, the service-role grants), TASK-023 (`fetchVerificationPage`),
TASK-024 (`inspectVerificationPage`). All merged.

## Allowed files

- app/api/cron/\*\* (new: the route)
- features/verification/\*\* (the window, the queue, the run, the writes)
- lib/security/cron-auth.ts (new: the secret comparison, which is a security
  boundary and belongs beside `turnstile.ts` and `rate-limit.ts` rather than
  inside a route file)
- lib/env/server-env.ts — only if `CRON_SECRET`'s rule needs stating; it
  already exists and should not need touching
- supabase/migrations/\*\* (one new migration: the queue function)
- supabase/tests/\*\*
- README.md (§18's schedule, §19 unchanged, §20's gap restated)
- .ai/PLAN.md (Phase 7)
- tests/\*\*

## Forbidden files

- every existing migration, `verification_checks` included — this task adds a
  function and changes no table, no constraint and no grant
- features/verification/fetch-page\*.ts,
  features/verification/inspect-page.ts, features/verification/html-scan.ts,
  features/verification/decode-body.ts — composed, never adjusted to suit the
  scheduler
- lib/database/service-role-client.ts — used, not changed
- vercel.json — deliberately not created; see decision 4
- app/(dashboard)/\*\*, components/\*\* — no screen shows a check until Phase 8

## Decisions

Chosen by Mikołaj Smoliniec (project owner), 2026-09-27:

- **A check window is one day.** Why: `verification_checks` is never pruned
  (TASK-022, PR #39 note 1), and `unique (deployment_id, check_window)` fixes
  the rate at one row per active deployment per window — so the window length
  _is_ the storage policy. Daily is 365 rows per active deployment per year
  against hourly's 8 760. A notice taken down is noticed within a day, which is
  the same order as the cache floor plus a customer's own deploy cycle. Cost,
  accepted: a notice can be absent for most of a day before any evidence says
  so, and the evidence therefore supports "checked daily" rather than
  "continuously monitored" — §72's no-legal-claims rule already forbids the
  stronger phrasing, and §18 now states the weaker one. Rejected: hourly (24×
  the storage, forever, and 24× the outbound volume against customers' sites,
  for a detection window nobody asked for) and six-hourly (the middle number,
  with no argument behind it but being in the middle). Shortening later is a
  configuration change; lengthening later leaves a permanently dense patch in
  append-only evidence, which is why the cheaper answer is the safer one to
  start from.
- **One invocation does a bounded batch under a wall-clock budget.** At most
  `VERIFICATION_RUN.batch` deployments, at most `VERIFICATION_RUN.concurrency`
  fetches in flight, and no new fetch is started once less than one whole fetch
  budget remains. Why: one slow target costs fifteen seconds, and a serverless
  invocation has a ceiling — a run that dies mid-flight has done partial work
  nobody can see, while a run that stops early leaves the unreached deployments
  with no row for the window, which is exactly the queue's definition of work
  to do. Under-checking is visible in the evidence; a timed-out invocation is
  not. Cost, accepted: the schedule has to tick more often than the window for
  the queue to drain — see proposal 2. Rejected: draining the whole window in
  one run (it fails as a whole the moment deployment count times worst case
  exceeds the ceiling) and a count cap with no clock budget (the cap then has
  to be set for the worst case, so every normal run under-uses its invocation).
- **One in-flight fetch per hostname.** On top of the global concurrency cap.
  Why: a customer may point many deployments at one host, and fifty
  simultaneous requests from our addresses is a burst that a host may
  reasonably treat as an attack — whereupon it answers 429 and our impoliteness
  is recorded as that customer's `HTTP_ERROR`. Serializing costs run time for
  exactly the customers who caused it. Cost, accepted: a customer with many
  deployments on one host is checked more slowly than one with many hosts.
  Rejected: the global cap alone (four at a time against one host is four times
  the polite rate for no gain) and a per-organization cap (a burst is a burst
  from the receiving host's view, and two organizations can share a host).
- **The route ships; the schedule does not.** No `vercel.json`, and no cron
  entry. Why: merging this must not be the act that starts fetching real
  customer sites. The first run against real hostnames should have a person
  behind it, and it keeps this pull request's blast radius equal to its
  migration. Cost, accepted: the deployed state does not match the repository
  until somebody adds the schedule, so the handoff and README §18 say what to
  add and the recommended cadence. Rejected: shipping the cron entry (the first
  real-world run of a job nobody has watched would happen as a side effect of a
  merge).

## Proposed by the implementer

Awaiting sign-off.

1. **The queue is a SQL function, not a query builder.**
   `public.verification_queue(p_check_window, p_limit)`, `security definer`,
   executable by `service_role` alone. Why: the predicate for "this deployment
   has something to show" already exists exactly once, inside
   `public.public_disclosure` — active deployment, active system, live
   organization, current version, `enabled` — and a second copy in TypeScript
   is the drift PR #35 note 2 was written about. The anti-join against
   `verification_checks` and the `max(version)` subquery cannot be expressed
   through PostgREST anyway. Rejected: joining in the route (four round trips
   and a filter that can be forgotten) and a view (it would need the window as
   a parameter).
2. **The window and the schedule are different things, and the schedule ticks
   more often.** A daily window with one daily tick would leave everything past
   the batch cap unchecked for the day. Because a deployment with a row for the
   window is no longer in the queue, any number of ticks inside one window
   drains it without duplicating anything — the unique constraint is not a
   safety net here, it is the mechanism. Recommended cadence: hourly.
3. **The queue is the only state.** No claim table, no lease, no cursor, no
   advisory lock. The work item is the absence of a row, and the idempotency is
   `unique (deployment_id, check_window)` — decided in TASK-022 precisely so a
   cron that fires twice or overlaps itself cannot write two rows. Two
   overlapping runs may fetch the same deployment twice; the second insert
   loses, and a duplicate _fetch_ is wasteful rather than wrong. Rejected: a
   claim column (it is a second piece of state to leak, and a crashed run leaves
   rows claimed forever unless a lease expires them — for a problem the unique
   constraint already solves).
4. **A failure row takes a deployment out of the queue; a fault of ours does
   not.** Every outcome the fetch and the inspection can describe is written as
   a row, including `DNS_ERROR` — that is the evidence. But when
   `fetchVerificationPage` or `inspectVerificationPage` _rejects_, the run logs
   the hostname and writes nothing (PR #40 note 4, owner 2026-09-27), so the
   deployment stays in the queue and the next tick tries again. Why that
   asymmetry is right: a customer's failure is a fact about their site and
   belongs in the record once per window; a bug of ours is not a fact about
   their site at all, and retrying is better than either recording it against
   them or losing it. Cost, accepted: a genuinely broken deployment of ours is
   retried every tick of the window, which is bounded and loud in the logs
   rather than silent.
5. **`CRON_SECRET` is compared as SHA-256 digests, in constant time.** Both
   sides hashed, then `timingSafeEqual` over two 32-byte buffers. Why not
   compare the strings directly the way `flow-ticket.ts` does: that comparison
   is preceded by a length check, which is safe there because the input is a
   hex signature of known length, and is a leak here because the secret's length
   is not public. Hashing makes both operands the same size whatever arrives.
   Rejected: `===` (short-circuits on the first differing byte).
6. **`Authorization: Bearer <secret>`, and nothing else.** The form Vercel Cron
   sends. A query parameter is refused even if present, because a URL ends up in
   access logs, browser history and referrers (§16), and a secret in a URL is a
   secret in somebody's log file.
7. **`GET`, with a side effect, deliberately.** Vercel Cron issues `GET` only.
   The usual objection — that a `GET` should not change state — is about
   caches, prefetchers and crawlers replaying it, and none can: the route
   answers nothing without the secret, sends `Cache-Control: no-store`, and a
   replay inside the same window is refused by the database rather than
   duplicated. Rejected: `POST` with a documented manual trigger (it would not
   be callable by the scheduler this application deploys behind).
8. **The response is counts, never hostnames.** `{ window, considered,
checked, failed, skipped, remaining }`. Why: a scheduler's dashboard stores
   response bodies, and which of our customers failed a check is not a fact for
   an external product's log. Per-deployment detail goes to our own structured
   log, where §24's redaction and retention already apply.
9. **The run is a pure function of a batch plus two injected capabilities.**
   `runVerificationBatch` takes the rows, a `fetch` and an `inspect`, so the
   schedule, the budget, the per-host serialization and the row-writing are
   tested without a network. The route is the only place that wires the real
   ones. This is the seam TASK-023 needed an ESLint rule to protect; here it is
   internal to the run and nothing in the application can reach past it.
10. **The time budget is the fetch's own bound.** A new fetch is started only
    while the remaining budget exceeds `VERIFICATION_FETCH_BOUNDS.totalMs`, so
    every fetch the run starts can finish honestly rather than being cut off
    into an `UNKNOWN_ERROR`. Imported from the fetch rather than restated, for
    the reason `WIDGET_PATH` is imported by the inspection.
11. **`payload_hash` and `previous_record_hash` stay null, and
    `disclosure_version` too.** §20's chain is still unwritten, and its gap now
    starts growing — README §20 already says evidence collected before the chain
    is not covered by it, and that sentence stops being hypothetical with this
    task's first run. `disclosure_version` is null because TASK-024 cannot
    observe one.
12. **A row's `check_window` comes from the run's clock, its `checked_at` from
    the database's.** The window is the schedule's fact; the time of the
    observation is not the writer's to assert (TASK-022's trigger already
    overrides it). A late or skipped tick writes for the window it is in and
    never backfills an earlier one: a row for a window nobody observed would be
    manufactured evidence.
13. **The window is UTC midnight.** Not the organization's local day: a window
    is our schedule's bucket, not a date a customer reads, and a per-tenant
    boundary would make one deployment's window depend on data the queue would
    then have to join.

## Invariants

- No row is written that says something the run did not observe.
- A fault of ours is never recorded as a customer's failed check.
- One row per deployment per window, enforced by the database rather than by
  the run.
- The secret is compared in constant time, and never reaches a log, a URL or a
  response.
- The service-role client is used only here, and only for work no signed-in
  user can do on their own behalf.
- One deployment's failure never stops the run.
- Nothing about which customers failed leaves in the HTTP response.

## Acceptance criteria

- An unauthenticated call, a wrong secret, and a secret of the wrong length are
  all refused with the same status and no hint of which.
- A deployment with a published, enabled notice is checked; one whose notice is
  off, whose system or deployment is archived, or whose organization is deleted
  is not in the queue at all.
- A second run in the same window writes no second row.
- A run with a deployment that throws still checks the others.
- A run that runs out of budget leaves the rest in the queue.

## Required tests

- `tests/unit/verification/check-window.test.ts` — the window boundary.
- `tests/unit/verification/run-verification.test.ts` — the batch: budget,
  concurrency, per-host serialization, one deployment throwing, the counts.
- `tests/security/verification/cron-auth.test.ts` — the secret: absent, wrong,
  wrong length, right, and that it is never logged or echoed.
- `tests/integration/verification/scheduler.supabase.ts` — against the real
  database: the queue's predicate, the idempotency, and a written row.
- `supabase/tests/verification_queue.test.sql` — the function's grants and its
  predicate.
