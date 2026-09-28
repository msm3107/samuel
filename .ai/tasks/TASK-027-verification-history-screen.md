# TASK-027 — The verification history screen

## Objective

Show a customer what was checked and when, and — when a check failed — what to
change. One deployment's checks, newest first, paged, with status communicated
by words and shape rather than by colour (§35). Closes Phase 8.

It also pays the amendment PR #43's review produced: `widget_reason` and
`redirect_reason` become named serializer fields, so the screen can show the
reason proposal 7 promised.

## Owner agent

Frontend, with one backend change (the serializer) and one query.

## Dependencies

TASK-015 (the deployment screen this links from), TASK-018a (the paging pattern
a screen follows, and its cursor-fallback rule), TASK-022 (the rows and their
serializer), TASK-024 (`WIDGET_REASONS`), TASK-025 (rows to read), TASK-026 (the
read, the cursor, README §31's paging rule). All merged.

## Allowed files

- features/verification/verification-check.ts (the two new serializer fields)
- features/verification/verification-history-queries.ts (the latest check)
- app/(dashboard)/dashboard/[organizationId]/deployments/[deploymentId]/checks/\*\*
  (new: the screen and its fixed text)
- app/(dashboard)/dashboard/[organizationId]/deployments/[deploymentId]/page.tsx
  (the summary and the link through)
- app/(dashboard)/dashboard/[organizationId]/deployments/messages.ts (the path)
- components/dashboard/\*\* (the status badge)
- README.md (§18's pointer to the screen), .ai/PLAN.md (Phase 8)
- tests/\*\*

## Forbidden files

- supabase/migrations/\*\* — **no schema change.** Both reasons are already
  stored, already bounded by the metadata constraint, and already validated by
  `verificationMetadataSchema`. Nothing is added to a row.
- features/verification/run-verification.ts, fetch-page\*.ts, inspect-page.ts,
  html-scan.ts, decode-body.ts, check-window.ts, verification-queries.ts — the
  writer is finished and a reader does not touch it
- app/api/\*\* — the API's shape changes only through the serializer both
  callers share, and no route's own code changes
- lib/database/service-role-client.ts — not imported by anything here

## Decisions

Chosen by Mikołaj Smoliniec (project owner), 2026-09-28.

- **The history is its own page**, `/dashboard/{organizationId}/deployments/
{deploymentId}/checks`, with the newest check summarised on the deployment page
  and a link through. Why: paging with `?before=` then re-runs one query rather
  than also re-reading the AI system, the current disclosure and the install
  readiness, none of which produce a row of history; the deployment page stays a
  page about the deployment rather than a page that is mostly a list; and it is
  what TASK-026's proposal 6 anticipated — the deployment's status rides along
  on the history query precisely so a separate screen can say which deployment,
  and whether an archived one, it is looking at. Cost, accepted: one more
  navigation, and a route shaped unlike the disclosure history, which sits on
  the disclosure screen. Rejected: a section on the deployment page (one screen
  and one precedent, but three queries re-run for every older page, under a page
  that already carries the status, the public ID, the install code and the
  archive control).
- **Status is words, shape and colour, in that order of authority.** The word
  ("Passed", "Failed") and a shape carry the meaning; colour is a third channel
  that carries nothing on its own, which is what §35 requires. Why: a page of up
  to 200 rows is opened to find the failures in it, and a reader scanning it
  needs something faster than reading every line. Cost, accepted: a red and
  green pair enters an otherwise monochrome dashboard — and that pair is the
  worst one for the commonest colour-vision deficiency, which is exactly why the
  word and the shape have to stand alone and are tested doing so. Rejected:
  monochrome (nothing to get wrong, but the list is hard to skim for the one
  thing it is read for) and the word alone (least scannable of the three).
- **The newest check explains itself in a panel; the rows below are compact.**
  The panel names what happened and what to change, in fixed text per failure
  code and per reason. Each row is one line: when, the status, and short labels.
  Why: checks are daily and a failure usually repeats for as long as it takes to
  fix, so the same paragraph 200 times is noise, and the list stops reading as a
  record of what happened. Cost, accepted: why a check failed last March reads
  as a short label rather than a sentence. Rejected: a sentence on every failed
  row, and a `<details>` per row (compact and complete, but 200 disclosure
  widgets on one page, the fix hidden behind a click on the row that most needs
  it, and more keyboard and screen-reader surface than either alternative).
- **An empty history states the schedule and promises nothing.** "No checks
  recorded yet. Active deployments are checked once a day." — a statement about
  how verification works, with no clock and no claim about this deployment. Why:
  TASK-025 shipped the route and the schedule is enabled outside the
  application, so a screen promising a first check within a day would assert
  something the application cannot know is true, and a promise that silently
  stops being true is worse than none. Cost, accepted: somebody who registered
  five minutes ago is told less than they would like. Rejected: naming an
  expected time, and saying only that there are none.

Carried in from the PR #43 review (owner, 2026-09-27), and implemented here:

- **`widget_reason` and `redirect_reason` are serialized as named,
  `z.enum`-bounded fields.** Both are fixed lists of strings with no customer
  data in them; the rest of `metadata` stays server-side. The whole argument is
  in TASK-026's proposal 7 as amended.

## Proposed by the implementer

Nine, awaiting sign-off.

1. **A second read, `readLatestVerificationCheck`, rather than a page of 200 for
   one row.** The deployment page needs the newest check and nothing else;
   asking `listVerificationChecks` for it would read 201 rows and drop 200.
   TASK-026's surface test was written as "no export is named like a writer"
   rather than as an exact list precisely so that a second _read_ could be added
   without weakening it, and this is that read.
2. **A bad cursor on this screen shows the newest checks; the API still refuses
   it.** Exactly TASK-018a's rule and for its reason: the screen's own links are
   always well formed, so an unreadable one arrived from somewhere else and the
   newest page is still the right answer, where a client calling the API asked
   for something exact and gets a 400.
3. **The screen renders no identifier a customer did not already navigate by.**
   No check id, no disclosure id, no organization id. A row is a time, a result
   and a reason.
4. **An unrecognized reason renders as no detail, not as an error.** The two
   vocabularies are public from this task on, and a value added by a later
   migration must not blank a screen or throw. The code's own sentence still
   shows.
5. **Every failure code and every reason has fixed text, and a test proves the
   tables are total.** The same arrangement as `HOSTNAME_MESSAGES`: the page
   shows text from a table keyed by a code, so nothing a server or a forged
   response chooses reaches the page as a message.
6. **The archived deployment's history stays readable, and says so.** TASK-022
   keeps the evidence; the screen states that checks have stopped rather than
   leaving a reader to infer it from a gap.
7. **`http_status` is shown only where it means something** — on `HTTP_ERROR`,
   where the number is the fact the customer acts on. A 200 beside a
   `WIDGET_NOT_FOUND` explains nothing and invites the reading that the check
   half-succeeded.
8. **A row is labelled by its window, not by the moment the check ran.** Found
   while writing the tests: the list is ordered and paged by `check_window`, and
   I was displaying `checked_at`. They agree for every row the scheduler writes
   today — `currentCheckWindow()` is that day's midnight — but a row written
   late, a backfill or a retry after an outage, would render out of order in a
   record a customer relies on. A window is a day, so it is shown as a date
   with no time to imply a precision it does not have, and the exact moment is
   shown for the newest check, where somebody reconstructing an incident wants
   it. It also makes README §31's cursor visible: the date on the last row is
   the value "Older checks" continues from.
9. **No word of §21's forbidden vocabulary, asserted by a test.** No
   "certificate", "certification" or "compliant" on this screen or in its text
   tables — §72's rule, tested here rather than waiting for Phase 9, because
   this is the first screen whose subject is evidence.

## Invariants

- No path here can change a check: the screen reads, and nothing else.
- The service-role client is not imported by any file in this task.
- `metadata` does not leave the server, apart from the two reason fields the
  owner accepted.
- Status is never communicated by colour alone (§35).
- No query is unbounded: the screen reads one page, and the summary reads one
  row.
- Another organization's deployment is not found, as on every other screen.

## Acceptance criteria

- A viewer, a member, an admin and an owner all see the history.
- Another organization's deployment, and a deployment id that is not a UUID, are
  both not found, without a query for the second.
- A failed newest check names what happened and what to change; where a reason
  exists, the reason is what is shown.
- Every failure code and every reason has text, proven by a total-map test.
- The status of every row is legible with colour removed.
- A deployment with no checks says so, and says how often checks run, without
  promising when.
- Paging reaches the whole history with no row repeated and none missing, and a
  malformed cursor shows the newest page rather than an error.

## Required tests

- Unit: the text tables are total over both vocabularies and the failure codes;
  no forbidden word appears in any of them; the cursor fallback.
- Security: the rendered page contains no `metadata` value other than the two
  reasons, no organization or disclosure identifier, and no other tenant's data.
- Integration, against the real database: the page renders for each role, pages
  correctly across a boundary, is not found for another organization's
  deployment, and says the right thing for an archived deployment and for one
  never checked.
