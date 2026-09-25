# TASK-018a — Paging the disclosure version history

## Objective

Give the disclosure history a way to older versions. TASK-017's
`listDisclosures` stops at 200 versions and TASK-018's screen says so and
stops there; every published version is permanent evidence, so there must
be a way to read past the two hundredth. This adds a `before` cursor to the
query and the API, and an "Older versions" link to the screen. It closes
Phase 5.

## Owner agent

Frontend

## Dependencies

TASK-016 (`disclosures`, its RLS and triggers), TASK-017
(`listDisclosures`, the API route), TASK-018 (the screen, its messages and
its tests).

## Allowed files

- features/disclosures/disclosure-queries.ts (the cursor) and
  disclosure.ts (the cursor's schema)
- app/api/organizations/[organizationId]/ai-systems/[systemId]/disclosures/route.ts
  (the query parameter)
- app/(dashboard)/dashboard/[organizationId]/systems/[systemId]/disclosure/\*\*
- tests/unit/disclosures/\*\*, tests/integration/disclosures/\*\*,
  tests/security/disclosures/\*\*, tests/e2e/dashboard/\*\*

## Forbidden files

- supabase/migrations/\*\* (no schema change: `version` is already unique
  per system and already indexed by TASK-016)
- lib/auth/\*\*, lib/security/\*\*, lib/validation/\*\*
- features/disclosures/languages.ts, disclosure-fields.ts,
  disclosure-form.ts
- components/dashboard/disclosure-form.tsx (the editor does not change)
- every other route, screen and feature

## Screens

| Path                                                                 | Permission          | Shows                                             |
| -------------------------------------------------------------------- | ------------------- | ------------------------------------------------- |
| `/dashboard/[organizationId]/systems/[systemId]/disclosure`          | `organization.read` | The editor (members only) and the newest versions |
| `/dashboard/[organizationId]/systems/[systemId]/disclosure?before=N` | `organization.read` | The versions below N, newest first. No editor     |

## Endpoints

| Method | Path                                                                             | Permission          | Change                                     |
| ------ | -------------------------------------------------------------------------------- | ------------------- | ------------------------------------------ |
| GET    | `/api/organizations/[organizationId]/ai-systems/[systemId]/disclosures?before=N` | `organization.read` | Optional `before`; absent means the newest |

## Decisions

Chosen by Mikołaj Smoliniec (project owner), 2026-09-25:

- **The editor is not shown on an older page.** A paged view shows the
  history only, with a link back to the newest versions. The editor
  publishes against the version it was loaded from, and on an older page
  the first row is not the current version; hiding it makes a publish
  against a stale version impossible by the page's shape rather than by
  the editor remembering which page it is on. Downside: a member reading
  back through the history clicks once to return before they can publish.
  Rejected: keeping the editor and reading the current version in a second
  query, which puts the editor's correctness in that query rather than in
  what the page is.
- **A page is 200 versions**, the same number the API caps at and the same
  as the AI systems and deployments lists. One number across the query,
  the API and the screen; a reader who follows a link gets the same rows
  the endpoint would give them. Downside: a page of 200 versions with
  their full text is long, and all of them are fetched even if the reader
  wanted the first few. Rejected: a smaller page on the screen only, which
  would make the screen and the API answer differently for the same
  system.
- **The history moves one way: older.** An "Older versions" link at the
  foot of the list, and a "Back to the newest versions" link once off the
  first page; moving toward newer is the browser's Back button. One
  parameter and one cursor, so there is nothing to get out of step.
  Rejected: an `after` parameter as well, which would put both directions
  in the page itself at the cost of a second cursor to validate and two
  more paths to test.

## Proposed by the implementer

All ten accepted on the PR #34 review. Accepted by Mikołaj Smoliniec
(project owner), 2026-09-25.

1. **The cursor is a version number, not an offset or a time.** `version`
   is unique per AI system, assigned by TASK-016's trigger, never reused
   and never changed, and `(ai_system_id, version)` is already the unique
   key the ordering uses. So `version < before` names exactly one place in
   one system's history, and a version published while someone is paging
   cannot shift the page under them or make a row appear twice. Rejected:
   `offset`, which does both of those and gets slower the further back it
   goes; `created_at`, which is not unique and needs a tiebreaker.
2. **`before` is exclusive.** `?before=N` returns versions below N, so the
   link at the foot of a page carries that page's last version and the
   next page starts exactly one below it, with nothing repeated and
   nothing skipped. Rejected: inclusive, which repeats one row on every
   page.
3. **The cursor is validated as a string, then as an integer.** The same
   shape TASK-018's hidden version field uses: up to ten digits, then
   1..2147483647, Postgres's `integer`. A value outside that never reaches
   a query. `before=1` is allowed and returns nothing, which is the
   truthful answer for "older than the first version" rather than a
   refusal.
4. **A cursor the screen cannot read is ignored**, and the newest versions
   are shown, as the AI systems list does with an unknown `status`. A
   query parameter someone typed or a stale link is not an error worth a
   404, and the screen's own links are always well formed. The API
   refuses the same value with 400 `invalid_request`, as it does every
   other malformed parameter: a client calling the endpoint asked for
   something exact and should be told it could not be given, while a
   person following a link should still see the page.
5. **`truncated` keeps its meaning: there are more beyond this page.** On
   the newest page that is "more older versions exist"; on a paged view
   the same. The caller computes the next cursor from the last row it was
   given, so the query returns no cursor of its own and nothing new is
   serialized. Rejected: returning a `nextBefore`, which is the last row's
   version written twice.
6. **The "Current" badge and the notes about what the widget shows only
   appear on the newest page.** On an older page the first row is not the
   current version, and the page does not know what is. Saying nothing is
   better than saying something that may be wrong, and the link back to
   the newest versions is where the current one is.
7. **An older page that is empty says so** — "No versions older than
   version N" — rather than showing TASK-018's "Nothing published yet",
   which is about the system, not about the page. Reached by editing the
   parameter or following an old link; both deserve a true sentence and
   the way back.
8. **The link's text says how many**, "Older versions", with the count of
   what is shown above it in the existing note, so a reader knows the list
   is cut before they reach its foot. TASK-018's note ("Showing the 200
   newest versions") becomes the sentence that carries the link.
9. **No new query and no new index.** The cursor is one more predicate on
   the query TASK-017 already makes, filtering the embedded `disclosures`
   by version; `(ai_system_id, version)` is the unique key, so the plan is
   the same range scan backwards from a bound. The RLS policy is the same
   one, on the same rows.
10. **The paged view is still one render of one page**, not a client-side
    "load more". The screen stays a server component with no state, works
    without JavaScript, and a reader can link a colleague to exactly what
    they are looking at.

## Invariants

- **Authorization is unchanged.** The cursor is read after
  `organization.read` is proved, and it names no organization and no
  system: it is one integer filtering rows the caller can already read.
  RLS refuses every row that is not theirs whatever the cursor says.
- **The cursor never reaches a query unvalidated.** A non-integer, a
  negative, a value above Postgres's `integer`, or a repeated parameter is
  refused or ignored before the query is built.
- **No message text is trusted.** Every version on an older page is
  rendered exactly as TASK-018 renders it: plain text in a paragraph,
  never markup.
- **A paged view cannot publish.** No form, no action and no hidden
  version field is rendered when `before` is present.
- **Nothing is revealed by the cursor.** A system this organization does
  not have answers "not found" with or without a cursor, and with or
  without versions below it.

## Acceptance criteria

- `listDisclosures(access, id, { before })` returns only versions below
  `before`, newest first, at most 200, with `truncated` true when more
  remain.
- `GET …/disclosures?before=N` returns the same, and answers 400
  `invalid_request` for a `before` that is not a version number or is
  given twice.
- The screen at `?before=N` shows those versions, no editor, a link back
  to the newest versions, and an "Older versions" link while more remain.
- The screen with an unreadable `before` shows the newest versions.
- The newest page is unchanged from TASK-018 except that its truncation
  note now carries the link to older versions.
- A reader can reach every version of a history longer than 200 by
  following links only.

## Required tests

- Unit: the cursor's schema — digits, bounds, leading zeros, absent;
  `disclosurePath` with and without a cursor.
- Unit (mocked query): the screen's choice of editor, notes, badge, empty
  text and links, on the newest page and on an older page, including a
  history of exactly 200 and one of 201.
- Security (mocked): a paged view renders no form and no action for a
  member; a viewer sees no editor on either page; an unreadable cursor
  never reaches the query.
- Security (real database): another organization's system is not found
  with a cursor as without one; a cursor cannot read a row RLS refuses.
- Integration (real database): a history of five versions read page by
  page with `before`, through the query and through the API, returns each
  version exactly once and in order.
- Browser: publish three versions, follow a cursor link built by hand to
  an older page, see no editor, and follow the link back to the newest.

## Amendment: the PR #34 review

Accepted by Mikołaj Smoliniec (project owner), 2026-09-25. Three
non-blocking notes; none changed the code.

- **Note 1, the count.** The review found "eleven proposals" in the pull
  request's description and in the implementer's report, where this
  contract has ten. Ten is right: eleven was TASK-018's count, carried over
  by mistake. Nothing was dropped and no eleventh was ever written. The
  pull request's description was corrected, and the sign-off above names
  ten.
- **Note 2, a cursor above the newest version.** `?before=999999` on a
  three-version system returns all three, so the page renders as an older
  page: no "Current" badge, no editor, and the sentence "The current
  version is on the newest page" while it is in fact the first row on
  screen. **Left as it is, deliberately.** Knowing that a cursor is above
  everything means knowing the system's newest version, which is a second
  query — exactly what decision 1 took off this page. Nothing false is
  said about any row: every version shown is real, in order, with its own
  language, state, time and publisher. The screen's own links can never
  produce such a cursor; only a hand-typed address or a link from
  elsewhere can. Rejected: having the query also return the newest
  version, which would put the editor's presence back inside a query's
  result, the arrangement decision 1 rejected.
- **Note 3, the paging protocol is not documented for external callers.**
  `truncated: true` with no cursor means a client must know the rule "ask
  again with the last row's version". Proposal 5 stands — a `nextBefore`
  would be the last row's version written twice — but an external caller
  has nowhere to read the rule today. **Owed** to whichever task first
  documents the customer-facing API; not a change here.

### Out of contract

- `.ai/PLAN.md`: Phase 5's heading now carries the "**complete**" marker,
  as Phase 0's does. The plan is not in this task's Allowed files; the
  owner asked for it on this branch (2026-09-25) under their standing
  permission to edit outside the list, and it is recorded here.
