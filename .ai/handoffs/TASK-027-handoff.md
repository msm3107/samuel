## Handoff

### Summary

The verification history screen (TASK-027), which **closes Phase 8**: one
deployment's checks, newest first, paged, with what to change when one failed,
and status communicated by words and shape rather than by colour (§35).

It also pays the amendment PR #43's review produced: `widget_reason` and
`redirect_reason` are serialized as named fields, so the screen shows the reason
TASK-026's proposal 7 promised.

**No migration.** Both reasons were already stored, already bounded by the
metadata check constraint and already validated by `verificationMetadataSchema`.
Nothing is applied on merge.

### Decisions

Owner, 2026-09-28.

1. **The history is its own page**, `/dashboard/{organizationId}/deployments/
{deploymentId}/checks`, with the newest check summarised on the deployment page
   and a link through. Paging then re-runs one query rather than also re-reading
   the AI system, the current disclosure and the install readiness — none of
   which produce a row of history. Cost: one more navigation, and a route shaped
   unlike the disclosure history, which sits on the disclosure screen.
2. **Status is a word, a shape and a colour, in that order of authority.** The
   word is the status; the shape repeats it; the colour carries nothing alone,
   which is what §35 requires. Cost: a red and green pair enters an otherwise
   monochrome dashboard, and that pair is the worst one for the commonest
   colour-vision deficiency — which is why the other two channels are the ones
   tested.
3. **The newest check explains itself in a panel; the rows below are compact.**
   Daily checks repeat a failure for as long as it takes to fix, and the same
   paragraph two hundred times stops the list reading as a record of what
   happened. Cost: why a check failed last March reads as a short label.
4. **An empty history states the schedule and promises nothing.** The schedule
   is enabled outside the application, so a promised first check would be a
   claim the application cannot know is true.

Carried in from the PR #43 review (owner, 2026-09-27) and implemented here: the
two reasons are serialized as named, `z.enum`-bounded fields; nothing else about
`metadata` leaves.

Implementer: nine proposals, awaiting sign-off. A second read
(`readLatestVerificationCheck`) rather than a page of 200 dropped to one; a bad
cursor on the screen showing the newest checks where the API refuses it; no
identifier a reader did not navigate by; an unrecognized reason rendering as no
detail rather than as an error; fixed text per code and per reason, with a
totality test; an archived deployment's history staying readable and saying so;
`http_status` shown only on `HTTP_ERROR`; rows labelled by their window rather
than by the moment the check ran; and no word of §21's vocabulary, asserted by a
test. The contract states each one's reason and what was rejected.

### Files changed

- `.ai/tasks/TASK-027-verification-history-screen.md` (new): the contract
- `features/verification/verification-check.ts`: `widgetReason`,
  `redirectReason`, and `REDIRECT_REASONS` exported
- `features/verification/verification-history-queries.ts`:
  `readLatestVerificationCheck`
- `app/(dashboard)/dashboard/[organizationId]/deployments/[deploymentId]/checks/page.tsx`
  (new), `…/checks/messages.ts` (new): the screen and its fixed text
- `app/(dashboard)/dashboard/[organizationId]/deployments/[deploymentId]/page.tsx`:
  the summary and the link through
- `components/dashboard/verification-status.tsx` (new): the status badge
- `tests/unit/verification/check-messages.test.ts` (new),
  `tests/integration/verification/verification-screen.supabase.ts` (new),
  `tests/security/verification/verification-screen.supabase.ts` (new)
- `tests/unit/verification/verification-check.test.ts`,
  `tests/security/verification/verification-history-surface.test.ts`: the two
  new serializer fields
- `README.md` §18 ("What a customer sees"); `.ai/PLAN.md` Phase 8

### Security considerations

- **The whole screen is a session read under row-level security.** No file in
  this task imports the service-role client, and the two query modules stay
  separate: the scheduler writes as nobody, this reads as somebody.
- **`metadata` still does not leave the server, apart from the two reasons the
  owner accepted.** The isolation suite renders the page for a check carrying
  `final_host`, `content_type`, `charset`, `response_bytes` and `duration_ms`,
  and asserts none of them appears — after stripping UUIDs from the HTML, so the
  assertion cannot pass or fail by chance on a hexadecimal identifier.
- **Both reason vocabularies are fixed lists of strings.** Neither can carry
  anything read off a customer's page: that is why `widget_tags` is a count, and
  the same property is what makes these two showable.
- **The lookup from a stored string to its text uses `Object.hasOwn`**, so a
  value naming an inherited property — `toString`, `constructor` — finds nothing
  rather than rendering a function. Tested.
- **Nothing here can change a check.** The feature exports reads only; the table
  grants no update or delete to any role and a trigger refuses both regardless.
- **Another organization's deployment is not found**, the same answer as one
  that does not exist, and so is a deployment id that is not a UUID — without a
  query for the second. A user with no membership is not found. All proven by
  rendering the real page against real RLS.
- **A viewer may read.** There is no role that may not: `organization.read` is
  `viewer`, deliberately, so no test asserts a role below it — such a test could
  not fail.
- **No claim §72 forbids.** A test scans every string the screen can show for
  "certificat", "compliant", "compliance", "guarantee" and "verified by". It
  caught one on the first run: `CONNECTION_FAILED` said "a certificate the check
  could not accept", meaning TLS. The text was reworded rather than the test
  narrowed — the word does not belong on this product's screens even in its
  innocent sense, and Phase 9 has to pass the same test for reports.

### Verification

```
pnpm typecheck                      pass (app and widget projects)
pnpm lint                           pass
pnpm format:check                   pass
pnpm test                           pass — 77 files, 2111 tests
pgTAP (supabase test db --local)    pass — 10 files, 343 tests
real-database vitest                pass — 38 files, 454 tests
Playwright (browser suite)          pass — 31 tests
next build                          pass — compiled successfully
```

Database reset to the migration head before the database suites and again before
the browser suite. `/dashboard/[organizationId]/deployments/[deploymentId]/checks`
is in the build's route list. `CODEX-SECURITY.md`'s sha256 checked before and
after Prettier: unchanged (`78d81a3…`), and Prettier was run on changed files by
name.

### Two things worth reading before Phase 9

- **A row is labelled by its window, and this was a defect the tests caught.**
  The list is ordered and paged by `check_window` and I was displaying
  `checked_at`. They agree for every row the scheduler writes today —
  `currentCheckWindow()` is that day's midnight — so nothing would have looked
  wrong until the first backfill or the first retry after an outage, at which
  point a record a customer relies on would have rendered out of order. The
  window is a day, so it shows as a date with no time; the exact moment shows
  for the newest check only. A useful side effect: README §31's cursor is now
  visible, because the date on the last row is the value "Older checks"
  continues from.
- **The §72 test belongs to Phase 9 as much as to this task.** Phase 9's exit
  criteria require that no report, filename, heading or download path uses
  "certificate", "certification" or "compliant". The same assertion now runs
  over this screen's text tables, and it has already caught one honest sentence
  — which is the evidence that the test earns its place rather than decorating
  the suite.

### Before merging

- **No migration**, no schema change, no new policy or grant.
- **One existing response shape changes**: `SerializedVerificationCheck` gains
  `widgetReason` and `redirectReason`, so
  `GET …/deployments/{id}/verification-checks` returns two more fields. Additive
  — no field is removed or renamed, and no client exists outside this
  repository.

### Remaining concerns

- **`deploymentStatus` on the history query is redundant for this screen.**
  TASK-026's proposal 6 justified it as what lets a screen say whether it is
  reading an archived deployment — and the screen reads the deployment anyway,
  for the hostname in its heading and breadcrumbs, so it could have used that.
  It is not wasted: it rides along on a query that had to happen, and an API
  client that is not also fetching the deployment does need it. But the
  justification as written is stronger than this screen's use of it.
- **The list shows one day per row and nothing about gaps.** A deployment that
  was not checked for a week shows six missing rows, and the screen does not
  say so. Phase 12's alerting is where "a run that stops happening" is meant to
  be noticed; a screen that draws the gap would be a good addition before then.
- **No organization-wide history**, still deferred to Phase 9 with its own
  cursor question.
- **Owed, unchanged:** the TASK-010 to TASK-021 sign-offs; §20's hash chain and
  its ordering question; `learnMoreUrl`; a cache purge on publish; a hard
  ceiling at the edge if the public endpoint's alert fires; **key rotation plus
  `git stash drop`**; stale-save protection on the AI system edit form; alerting
  on a verification run that stops happening.
