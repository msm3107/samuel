# TASK-026 — Reading a deployment's verification history

## Objective

Let a customer read what was checked and when: one deployment's verification
checks, newest first, with bounded pagination, through the session client and
row-level security. Opens Phase 8.

It also pays PR #34 note 3 — the paging rule this codebase uses is written down
in README §31, once, for both paged endpoints.

No screen shows it yet. TASK-027 is the history UI.

## Owner agent

Backend

## Dependencies

TASK-011 (`deployments`, its RLS), TASK-013 (`OrganizationAccess`,
`assertAccessAllows`, the deployments API), TASK-018a (the paging pattern this
follows), TASK-022 (`verification_checks`, its RLS, its serializer),
TASK-025 (the rows to read). All merged.

## Allowed files

- features/verification/verification-check.ts (the cursor's schema)
- features/verification/verification-history-queries.ts (new: the read)
- app/api/organizations/[organizationId]/deployments/[deploymentId]/verification-checks/route.ts
  (new)
- README.md (§31's paging rule, §18's pointer to it)
- .ai/PLAN.md (Phase 8)
- tests/\*\*

## Forbidden files

- supabase/migrations/\*\* — **no schema change at all.** The cursor rides the
  index `unique (deployment_id, check_window)` already created, and the read
  needs no new policy: TASK-022's `verification_checks_select_member` already
  admits every member of a live organization, viewers included.
- features/verification/verification-queries.ts,
  features/verification/run-verification.ts,
  features/verification/fetch-page\*.ts, inspect-page.ts, html-scan.ts,
  decode-body.ts, check-window.ts — the scheduler is finished; this task only
  reads what it wrote
- lib/database/service-role-client.ts — and it is not imported here either;
  see the invariants
- app/(dashboard)/\*\*, components/\*\* — TASK-027 owns the screen
- app/api/cron/\*\* — the writer is not touched by a reader

## Decisions

Chosen by Mikołaj Smoliniec (project owner), 2026-09-27:

- **The cursor is `check_window`, not `checked_at`.** Why: `unique
(deployment_id, check_window)` guarantees one row per deployment per window,
  so a `<` cursor cannot skip a row — the guarantee is in the schema rather
  than in how the data happens to look. `checked_at` is not unique, and two
  rows sharing a timestamp would make a page boundary drop a row of permanent
  evidence. It also needs no migration: that unique constraint's own btree
  index serves `where deployment_id = ? and check_window < ? order by
check_window desc` exactly. Cost, accepted: TASK-022 created
  `(deployment_id, checked_at desc)` "for Phase 8" and this task does not use
  it — it stays for the organization-wide reads Phase 9's reports need.
  Rejected: `checked_at` alone (a silent skip in evidence a customer relies on,
  and nothing in the schema forbids the tie) and a keyset cursor on
  `(checked_at, id)` (correct everywhere, including across deployments, but two
  columns to encode, validate and compare for a consumer that does not exist
  until Phase 9).
- **One deployment's history, and no organization-wide read.** Why: it is what
  TASK-027's screen needs, and the organization-wide index is described in
  TASK-022 as being for "Phase 8, Phase 9's reports" — Phase 9 is where a
  report actually reads across deployments, with its own aggregation and its own
  cursor question, `check_window` not being unique there. Cost, accepted: a
  customer cannot yet ask "what failed anywhere last week", which is a question
  Phase 9 exists to answer. Rejected: both reads now, which would settle the
  organization-wide cursor for a caller nobody has written.
- **A page is 200 checks**, the same number as every other list here. Why: one
  number across the query, the API and the screen, which is the rule TASK-018a
  settled — a reader who follows a link gets the rows the endpoint would give
  them. With daily windows that is about seven months per page, and a check row
  is small where a disclosure version carries its whole message. Cost,
  accepted: reading a long history takes several requests. Rejected: 365 (a
  year reads nicely, but it breaks the one-number rule for no structural reason,
  and it would quietly change meaning if the window length ever did) and 50 (the
  screen and the API would answer differently for the same deployment).
- **The paging rule is documented in README §31, here.** Why: this task adds the
  second paged endpoint, so the pattern is a pattern rather than one instance,
  and PR #34 note 3 has been carried through three handoffs waiting for
  "whichever task documents the customer-facing API". Cost, accepted: §31 grows
  a subsection about a convention rather than a rule of the framework.

## Proposed by the implementer

All nine accepted by Mikołaj Smoliniec (project owner), 2026-09-27, proposal 7
as amended below.

1. **The read goes through the session client, and this module never imports the
   service-role one.** Row-level security is what makes another organization's
   history unreadable, and `verification_checks_select_member` already admits
   every member of a live organization including a viewer — evidence is the
   thing customers rely on, so a viewer may read it. `assertAccessAllows(access,
"organization.read")` is checked first anyway, so the application says no
   before the database has to.
2. **The query reads from `deployments` and embeds the checks.** So a deployment
   that does not exist in this organization is `null` — a 404 — while a real
   deployment with no checks yet is an empty page. Those are different facts and
   a screen needs to tell them apart. It follows `listDisclosures` exactly,
   including naming the foreign key (`verification_checks_deployment_fkey`),
   because the key is composite. Rejected: querying `verification_checks`
   directly, which answers `[]` to both questions.
3. **The cursor is an ISO timestamp, not a date.** `?before=2026-09-27` would be
   prettier while windows are daily, and it would break the day the window
   length changes. A timestamp is window-length-agnostic, and the window is not
   a date a customer chose — README §18 says it is our schedule's bucket.
4. **One more row than the page is read, and the extra one is dropped.** How
   `truncated` is known without a `count`, which is the same trick
   `listDisclosures` uses and the reason both can promise a bounded result set.
5. **`truncated: true` carries no cursor, and §31 now says what to do about
   it.** The client asks again with the last row's `checkWindow`. Documenting the
   rule rather than adding a `nextCursor` field keeps both paged endpoints the
   same shape; changing the shape of the disclosure endpoint is not this task's
   to do.
6. **The deployment's status comes back with the page.** An archived
   deployment's history is still readable — TASK-022 keeps its evidence — so the
   screen has to be able to say which it is looking at, and a second query for
   one column would be a second round trip for a fact the first one already had
   in hand.
7. **Nothing new is serialized _here_.** `serializeVerificationCheck`
   (TASK-022) is what leaves this feature: no organization id, no disclosure id,
   no `metadata` object, and §31's rule is that a route returns a serializer's
   output and never a row.

   **Amended by the owner, 2026-09-27 (PR #43 review, note 1).** As originally
   written this proposal contained two sentences that cannot both be true: it
   promised "the screen shows the failure code and the reason" while the
   invariant below withholds `metadata`, where the reason lives, and
   `SerializedVerificationCheck` has no field for it. What a customer would
   actually see is `WIDGET_NOT_FOUND`, with no way to tell a missing tag from a
   copy served off their own host from a tag a browser will not execute — and
   both reason vocabularies were argued for, across two reviews, precisely on
   the grounds that they are the one fact telling a customer what to change
   (`WIDGET_REASONS`, TASK-024 and PR #41's blocking finding;
   `metadata.redirect_reason`, PR #40 note 2).

   The promise stands and the shape changes: **`widget_reason` and
   `redirect_reason` are serialized as named fields, bounded by the same
   `z.enum`s the row schema already declares, in TASK-027** — the task that
   writes the screen that renders them. Nothing else about `metadata` leaves.
   Why these two and not the object: both are fixed lists of strings with no
   customer data in them by construction, which is documented at their
   declarations and is why `widget_tags` is a count rather than the identifier
   found on the page. The invariant's substance is `final_host`,
   `content_type`, `charset`, the counts and the timings; those stay ours.

   Why named fields rather than the object: the whitelist exists so that a new
   `metadata` key is a reviewed migration. Passing the object through would make
   adding a key an unreviewed change to a public API, which moves the drift
   instead of removing it. Named enum fields also keep the API typed, so a
   renamed key fails typecheck rather than rendering nothing. Cost, accepted:
   two fields to keep in step with the vocabularies, a future reason added by
   migration touches the serializer, and the enum values become public — a
   client must treat an unrecognized reason as no detail rather than as an
   error. Rejected: serializing the widget reason only (it would leave
   `REDIRECT_BLOCKED` collapsing six causes with six different fixes into one
   code, which is what PR #40 note 2 settled) and retiring the promise (then the
   reason tells support what to change and the customer is left guessing, which
   is the situation the codes were introduced to end).

   Why in TASK-027 rather than here: this pull request is reviewed and green,
   and the field arrives with its only consumer, so it cannot ship unread. Until
   then `tests/security/verification/verification-history-surface.test.ts` pins
   the current answer in a test of its own, named for the fact that TASK-027
   changes it.

8. **The route derives the organization from its path, and the deployment from
   its path.** No identifier is read from a body or a query parameter except the
   cursor, which names no resource.
9. **A cursor that is not a timestamp is a 400, not an empty page.** A
   malformed cursor is a caller's bug, and answering "no older checks" would
   hide it. A _valid_ timestamp older than every row is an empty page, which is
   the true answer.

## Invariants

- No path offers an update or a delete of a verification check.
- The service-role client is not imported by this feature's read path.
- Every query filters by the organization in `OrganizationAccess`, and RLS
  enforces the same boundary underneath.
- No query can return an unbounded result set.
- `metadata` does not leave the server.
- A cursor cannot cause a row to be skipped.

## Acceptance criteria

- A member, an admin, an owner and a viewer can all read a deployment's history.
  There is no role that may not: `organization.read` is `viewer`, and evidence
  is the thing customers rely on.
- A deployment in another organization is a 404, not an empty page.
- A page is at most 200 checks and says whether it was cut short.
- Following the cursor from a truncated page reaches the next 200 with no row
  repeated and none missing.
- A malformed cursor is refused; a valid one below every row is an empty page.

## Required tests

- `tests/unit/verification/verification-history.test.ts` — the cursor schema,
  and the page's shape.
- `tests/integration/verification/verification-history.supabase.ts` — against
  the real database: paging across a boundary with no row skipped or repeated,
  an archived deployment's history, a deployment with no checks, and every role
  that may read.
- `tests/security/verification/verification-history-surface.test.ts` — what
  leaves the server, and that this feature has no writer. **Not** "a permission
  below `organization.read`": `organization.read` maps to `viewer`, which is the
  lowest role there is, so such a test could not fail and asserting it would be
  theatre. The cross-tenant case needs real row-level security and is in the
  integration suite instead.
