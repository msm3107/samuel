## Handoff

### Summary

Reading a deployment's verification history (TASK-026), which opens Phase 8: one
deployment's checks, newest first, at most 200 a page, through the session
client and row-level security.

It also pays PR #34 note 3 — the paging rule both paged endpoints follow is now
written down in README §31, once, for both.

**No screen shows it yet.** TASK-027 is the history UI.

**No migration.** This is the first Phase 7 or 8 task with no schema change at
all: the cursor rides the index `unique (deployment_id, check_window)` already
created, and `verification_checks_select_member` already admits every member of
a live organization.

### Decisions

Owner, 2026-09-27.

1. **The cursor is `check_window`, not `checked_at`.** The unique constraint
   guarantees one row per deployment per window, so a `<` cursor cannot skip a
   row — by the schema, rather than by how the data happens to look. `checked_at`
   is not unique, and two rows sharing a timestamp would make a page boundary
   drop a row of permanent evidence. Cost: TASK-022 created
   `(deployment_id, checked_at desc)` "for Phase 8" and this task does not use
   it; it stays for Phase 9's organization-wide reads.
2. **One deployment's history, no organization-wide read.** It is what TASK-027
   needs, and reading across deployments is Phase 9's — where `check_window` is
   not unique and the cursor question has to be answered again. Cost: a customer
   cannot yet ask "what failed anywhere last week".
3. **A page is 200 checks**, the same number as every other list, so the screen
   and the API answer alike. About seven months of daily checks per page.
4. **The paging rule is documented in README §31, here.** This is the second
   paged endpoint, so the pattern is a pattern rather than one instance.

Implementer: nine proposals, **all nine accepted by Mikołaj Smoliniec (project
owner), 2026-09-27**, proposal 7 as amended in the contract. The session client and no
service-role import on the read path; the query reading from `deployments` and
embedding the checks so "no such deployment" and "no checks yet" are different
answers; an ISO timestamp cursor rather than a date, because a date would break
when the window length changes; one row more than the page read and dropped, to
know `truncated` without a count; no `nextCursor` field, documented instead;
the deployment's status riding along on the query that was needed anyway;
nothing newly serialized, so `metadata` does not leave the server; the
organization and the deployment taken only from the path; and a malformed cursor
refused rather than treated as absent. The contract states each one's reason and
what was rejected.

### Files changed

- `.ai/tasks/TASK-026-verification-history.md` (new): the contract
- `features/verification/verification-check.ts`: `verificationCursorSchema`
- `features/verification/verification-history-queries.ts` (new): the read
- `app/api/organizations/[organizationId]/deployments/[deploymentId]/verification-checks/route.ts`
  (new)
- `tests/unit/verification/verification-history.test.ts` (new)
- `tests/security/verification/verification-history-surface.test.ts` (new)
- `tests/integration/verification/verification-history.supabase.ts` (new)
- `README.md` §31 (the paging rule); `.ai/PLAN.md` Phase 8

### Security considerations

- **The read is a session read, under row-level security.** This module does not
  import the service-role client and must not: a read a member is entitled to is
  a read the session client can serve. The scheduler writes with the service
  role because no signed-in user may produce their own evidence; the two live in
  separate modules so neither can drift into the other's client, and a test
  asserts the writer is not among this module's exports.
- **`organization.read` is asserted before the query**, so the application
  refuses before the database has to. There is no role that may not read: the
  permission maps to `viewer`, deliberately, because evidence is the thing
  customers rely on. A test for "a role below read" would therefore be
  unfalsifiable, and the handoff says so rather than shipping one.
- **Another organization's deployment is a 404, not an empty page**, and the same
  404 as a deployment that does not exist — so it says nothing about what exists.
  Proven through the route with a real signed-in user and real RLS.
- **A caller with no role at all gets 403.** Also proven through the route.
- **`metadata` does not leave the server.** The integration suite reads the
  response body as text and asserts the words are absent, rather than trusting
  the serializer's shape.
- **No path can change a check.** This feature exports one function and it is a
  read; the table grants no update or delete to any role, and a trigger refuses
  both regardless.
- **Every query is bounded.** 201 rows at most, and the extra one is dropped
  after telling us `truncated`. No count query, so no query's cost grows with a
  tenant's history.
- **A malformed cursor is a 400**, not a silently ignored parameter — otherwise
  a client's bug would look like an empty history.

### Verification

On `8e4e612`, the commit the review read:

```
pnpm typecheck                      pass (app and widget projects)
pnpm lint                           pass
pnpm format:check                   pass
pnpm test                           pass — 76 files, 2034 tests
pgTAP (supabase test db --local)    pass — 10 files, 343 tests
real-database vitest                pass — 36 files, 434 tests
Playwright (browser suite)          pass — 31 tests
next build                          pass — compiled successfully
```

Database reset to the migration head before the database suites and again before
the browser suite.

Re-run on the amendment commit, which changes one route, two test files and four
documents:

```
pnpm typecheck                      pass (app and widget projects)
pnpm lint                           pass
pnpm format:check                   pass
pnpm test                           pass — 76 files, 2035 tests
real-database vitest                pass — 36 files, 435 tests
next build                          pass — compiled successfully
```

One more test in each: the surface test split in two, and the repeated-cursor
test. **pgTAP and the browser suite were not re-run** — this commit changes no
SQL, no migration and no user interface, and they passed on `8e4e612`. CI runs
both regardless.

**The new test was checked against its own absence.** With `readCursor` restored
to `searchParams.get`, "refuses a repeated cursor, both values well formed"
fails with `expected 200 to be 400`; with the fix it passes. Worth doing here
because the other lesson of this task is a test that passed for the wrong
reason.

`CODEX-SECURITY.md`'s sha256 checked before and after Prettier: unchanged
(`78d81a3…`), and Prettier was run on changed files by name.

### The PR #43 review, and what it hands TASK-027

Verdict: APPROVE WITH NON-BLOCKING NOTES at `8e4e612`. Both notes were accepted;
one changed this pull request and one changed TASK-027's shape.

**Note 1 — proposal 7 promised a screen this serializer cannot produce, and the
owner amended it rather than retiring it.** The proposal said "the screen shows
the failure code and the reason" while the invariant withholds `metadata`, where
the reason lives. So `widget_reason` and `redirect_reason` **are serialized as
named, `z.enum`-bounded fields in TASK-027**, and nothing else about `metadata`
leaves. The contract states the reasoning, the rejected alternatives and the
accepted costs.

**TASK-027 therefore owns three edits before it writes a component:**

1. `SerializedVerificationCheck` and `serializeVerificationCheck` gain
   `widgetReason` and `redirectReason`, typed from `WIDGET_REASONS` and the
   redirect vocabulary the row schema already declares. No migration: both keys
   exist in `metadata` and both are already bounded there.
2. `tests/security/verification/verification-history-surface.test.ts` — the test
   named "still withholds the widget reason, which TASK-027 changes" becomes a
   positive assertion, and the expected key list grows by two. The test above it,
   which asserts the `metadata` _object_ does not leave and that `final_host`
   never appears, must **not** be widened.
3. The screen renders the reason as text beside the failure code, and treats an
   unrecognized reason as no detail rather than as an error — the enum values are
   public from then on, and a value added by a later migration must not break a
   client.

**Note 2 — a repeated `before` was resolved here where three other routes refuse
it, and is now refused.** `readCursor` reads `getAll("before")` and answers 400
`invalid_cursor` to more than one value, which is what `parseSingle` on the
deployments list and `parseCursor` on the disclosures list already do. §31 now
says so explicitly, so the rule this task documents and the route documenting it
agree. The integration suite asserts it with two _well-formed_ values, so it
cannot pass for the malformed-cursor reason.

One difference kept deliberately: those two routes answer `invalid_request`
where this one answers `invalid_cursor`. The specific code is the better one —
§10 asks for deterministic machine-readable failure codes, and a client that
gets `invalid_request` cannot tell which parameter it got wrong. Making the two
older routes specific is worth a task of its own; making this one vaguer to
match them is not.

### Two things worth reading before TASK-027

- **One of my own tests was unfalsifiable, and the fix is a fact about the
  wire.** PostgREST spells a `timestamptz` as `2020-01-05T00:00:00+00:00`, and
  every serializer in this codebase passes the database's spelling through — so
  a test comparing `checkWindow` against JavaScript's `…Z` form could never
  match, which made a "the cursor's own row is excluded" assertion pass for the
  wrong reason. Both comparisons are on instants now. **TASK-027 should parse
  `checkWindow` rather than compare it as text**, and a client echoing it back as
  a cursor works because the cursor schema accepts an offset.
- **The two timestamp spellings are a wart, not a bug.** Normalizing this
  serializer alone would make verification checks differ from every other
  endpoint, which is worse. If it is worth fixing it is worth fixing for all of
  them, in a task of its own.

### Before merging

- **No migration**, no schema change, no new policy or grant.
- **Nothing existing changed behaviour.** One new route, one new read, one new
  exported schema.

### Remaining concerns

- **No organization-wide history.** Deferred to Phase 9 with its own cursor
  question, because `check_window` is not unique across deployments.
- **`truncated` with no cursor is a convention a client must read about.** §31
  now documents it, but it is still a rule rather than something a response
  makes obvious. A `nextCursor` field would be self-describing; adding one to
  this endpoint alone would make the two paged endpoints differ, which is why it
  was not done here.
- **The unused index.** `(deployment_id, checked_at desc)` is not read by this
  phase. It is not dead — Phase 9 needs the organization-wide one and this one
  serves a deployment's history ordered by when it was checked rather than by
  window — but if Phase 9 does not use it either, it is worth dropping.
- **Owed, unchanged:** the TASK-010 to TASK-021 sign-offs; §20's hash chain and
  its ordering question; `learnMoreUrl`; a cache purge on publish; a hard ceiling
  at the edge if the public endpoint's alert fires; key rotation plus
  `git stash drop`; stale-save protection on the AI system edit form; alerting on
  a verification run that stops happening.
