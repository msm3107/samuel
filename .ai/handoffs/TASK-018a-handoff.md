## Handoff

### Summary

The disclosure history now has a way past its two hundredth version.
`listDisclosures` takes a `before` cursor, the GET endpoint takes it as a
query parameter, and the screen carries the links that build it. This closes
Phase 5.

- `listDisclosures(access, id, { before })`: the versions below `before`,
  newest first, at most 200, `truncated` when more remain.
- `GET …/disclosures?before=N`: the same, 400 `invalid_request` for a
  `before` that is not a version number or is given twice.
- `/dashboard/…/disclosure?before=N`: those versions, no editor, a link back
  to the newest, and an "Older versions" link while more remain.

A cursor is one integer narrowing rows the caller can already read. It names
no organization and no system, and it is read only after `organization.read`
is proved; RLS refuses everything that is not the caller's, cursor or no
cursor.

### Decisions

Owner, 2026-09-25:

1. **No editor on an older page.** The editor publishes against the version
   it was loaded from, and on an older page the first row is not the current
   version. Hiding it makes a stale publish impossible by the page's shape
   rather than by the editor knowing which page it is on. Rejected: a second
   query for the current version, which moves the guarantee into that query.
2. **A page is 200 versions**, the number the API caps at and the same as
   the AI systems and deployments lists, so a link and the endpoint answer
   alike. Rejected: a smaller page on the screen only.
3. **The history moves one way: older**, with a link back to the newest;
   moving toward newer is the browser's Back button. One cursor, nothing to
   get out of step. Rejected: an `after` parameter as well.

Implementer (proposed): the cursor is a version number,
not an offset or a time; it is exclusive; it is validated as text and then
as a Postgres `integer`; an unreadable one is ignored by the screen and
refused by the API; `truncated` keeps its meaning and no cursor is
serialized; the "Current" badge and the widget notes appear only on the
newest page; an empty older page says so; the truncation note carries the
link; no new query and no new index; the paged view is one server render,
not a client-side "load more". The contract states each one's reason and
what was rejected. All ten accepted on the PR #34 review. Accepted by
Mikołaj Smoliniec (project owner), 2026-09-25.

On the PR #34 review (owner, 2026-09-25): the count is ten, not eleven —
eleven was TASK-018's, carried over into the pull request's description by
mistake and corrected there (note 1); a cursor above the newest version is
left as it is, with its reason written into the contract (note 2); the
endpoint's paging rule is owed to whichever task documents the
customer-facing API (note 3). Phase 5 is marked complete in `.ai/PLAN.md`.

### Files changed

- `.ai/tasks/TASK-018a-disclosure-history-paging.md` (new): the contract
- `features/disclosures/disclosure.ts`: `disclosureCursorSchema`
- `features/disclosures/disclosure-queries.ts`: `DisclosureHistoryPage`, and
  `listDisclosures` takes it
- `app/api/organizations/[organizationId]/ai-systems/[systemId]/disclosures/route.ts`:
  the `before` parameter on GET
- `app/(dashboard)/dashboard/…/disclosure/page.tsx`: the cursor, the paged
  view, the links
- `app/(dashboard)/dashboard/…/disclosure/messages.ts`: `disclosurePath`
  takes an optional cursor
- Tests:
  - `tests/unit/disclosures/disclosure.test.ts`: the cursor's schema
  - `tests/unit/disclosures/disclosure-messages.test.ts`: the path with a
    cursor
  - `tests/security/disclosures/disclosure-page-paging.test.ts` (new,
    mocked): the page boundary and what a paged view renders
  - `tests/security/disclosures/disclosures-api.test.ts`: the cursor's
    refusals, and that a refused one never reaches a query
  - `tests/security/disclosures/disclosure-screen.supabase.ts` (real
    database): another organization's system, with a cursor and without
  - `tests/integration/disclosures/disclosures-api.supabase.ts` (real
    database): paging a five-version history through the endpoint
  - `tests/integration/disclosures/disclosure-screen.supabase.ts` (real
    database): the same through the screen
  - `tests/e2e/dashboard/disclosures.supabase.spec.ts`: an older page in a
    real browser, and the way back by keyboard

No migration. `version` is already unique per system and already the key the
ordering uses, so the cursor is one more predicate on TASK-017's query.

### Security considerations

- **The cursor is read after authorization, never before.** The page proves
  `organization.read` first; the route proves it and only then parses
  `before`. Someone with no role in the organization is refused 403 with an
  unreadable cursor, which a test pins.
- **Nothing outside Postgres's `integer` reaches a query.** A word, zero, a
  negative, a decimal, eleven digits, `2147483648`, an empty value or a
  repeated parameter is refused (API) or ignored (screen). The mocked suite
  asserts the query applied no bound in each of those cases.
- **The cursor reveals nothing.** It filters rows the caller can already
  read. A system in another organization is "not found" with a cursor as
  without one, whether or not it has versions, and whatever page the cursor
  names — proved against the real database for both organizations' paths.
- **A paged view cannot publish.** No form, no action and no hidden version
  field is rendered when `before` is present, for a member as for a viewer.
- **The message is still plain text**, rendered exactly as TASK-018 renders
  it. Nothing about paging touches that path.
- **The two surfaces differ deliberately.** The screen ignores an unreadable
  cursor and shows the newest versions; the API refuses it with 400. A
  person following a stale link should still see the page; a client asking
  for an exact page should be told it could not be given.

### Tests

Required by the contract: all covered.

One fault was found while running the browser suite, in the new test rather
than in the screen: Playwright's substring text matching is case-insensitive,
so "Version 3" matched the paragraph "Versions published before version 3."
The assertions now match the version label exactly.

### Commands run

On the final state of the branch:

```
pnpm typecheck                       pass
pnpm lint                            pass
pnpm format:check                    pass
pnpm test                            59 files, 1649 tests, pass
supabase test db --local             7 files, 273 tests, pass
vitest --config vitest.supabase.*    30 files, 389 tests, pass
pnpm test:e2e:supabase               12 tests, pass
next build                           pass
```

The database was reset to the migration head before the database suites, and
again before the browser suite.

`pnpm format` was run once, to fix five files' formatting. `CODEX-SECURITY.md`
is in `.prettierignore` since TASK-018, and its sha256 was checked before and
after: unchanged.

### The PR #34 review

Approved with three non-blocking notes, none of which changed the code.

- **note 1:** the pull request's description and the implementer's report
  said "eleven proposals" where the contract has ten. Ten is right; eleven
  was TASK-018's count. The description was corrected and the sign-off
  names ten.
- **note 2:** `?before=` above the newest version renders the current
  version as an older page — no badge, no editor. Left as it is: knowing a
  cursor is above everything means a second query for the newest version,
  which is what the owner's first decision took off this page. Nothing
  false is said about any row, and the screen's own links cannot produce
  such a cursor.
- **note 3:** `truncated: true` with no cursor means an external caller
  must know the rule "ask again with the last row's version", and there is
  nowhere to read it. Proposal 5 stands; the line is owed to whichever task
  documents the customer-facing API.

The review also confirmed what mattered most: the cursor reaches the query
as one exclusive bound and nothing else; a filter on the embedded versions
does not drop the parent row, so a cursor cannot turn a real system into a
404; cross-tenant answers are unchanged with a cursor present;
authorization comes before the cursor is parsed; and `.prettierignore` did
its job — `pnpm format` left `CODEX-SECURITY.md` alone.

### Remaining concerns

- **A page is still 200 versions.** A system with thousands of versions is
  read 200 at a time, and reaching the oldest takes as many clicks. If that
  ever becomes real, a smaller screen page is the change to make, not a
  different cursor: the cursor itself does not care how large a page is.
- **No way toward newer within the page.** By the owner's decision, that is
  the browser's Back button. A reader who opens an `?before=` link fresh, in
  a new tab, can only go older or back to the newest.
- **The endpoint's paging rule is undocumented** for external callers (PR
  #34 review, note 3): `truncated: true` carries no cursor, so a client must
  know to ask again with the last row's version.
- **A cursor above the newest version** renders the current version as an
  older page (PR #34 review, note 2). Deliberate, and the contract's
  amendment says why.
- **A member directory is still owed** if the publisher is ever to be named
  (TASK-018).
- **Owed from earlier tasks, unchanged:** TASK-019 must check
  `isPublicDeploymentId` first, require both statuses active, and not assume
  a restore issues a new ID.
