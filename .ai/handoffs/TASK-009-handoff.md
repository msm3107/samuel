## Handoff

### Summary

Members can list, read, create, edit, archive and un-archive their
organization's AI systems through four route handlers, on top of TASK-008's
table, row-level security and audit triggers. Viewers read.

There was no TASK-009 contract, so this task adds one. Its seven
decisions were proposed by the implementer and accepted on the PR #23
review. Accepted by Mikołaj Smoliniec (project owner), 2026-09-21.

### Decisions

1. **Routes are nested under the organization**
   (`/api/organizations/[organizationId]/ai-systems[/[systemId]]`).
   - Why: `requireOrganizationPermission` authorizes the organization
     before anything about a system is looked up. Every query then filters
     by `organization_id` and, for one system, by its ID, which the plan
     requires ("lookup by primary key alone does not exist").
   - Rejected: `/api/ai-systems/[id]`. It would have to find a row before
     knowing whose it is, and then authorize from the row, which inverts
     the order every other route uses.
   - Downside: longer URLs, and a client must know the organization ID. The
     dashboard always does.
2. **Archive and un-archive are `PATCH { "status" }`.**
   - Why: one write path for the table to secure and test, and TASK-008's
     trigger already writes `ai_system.archived` and `ai_system.unarchived`
     as their own events.
   - Rejected: separate `/archive` and `/unarchive` endpoints, a second
     path to secure for the same column.
   - Downside: a client archives by sending a body, not by calling an
     obvious URL.
3. **404 inside your organization, 403 outside it.**
   - An unknown system in an organization the user belongs to is 404
     `ai_system_not_found`. Another organization's system ID is
     indistinguishable from a nonexistent one, and a non-UUID is treated
     the same way without a query.
   - An organization the user doesn't belong to stays 403
     `organization_access_denied`, whatever system ID follows.
   - Rejected: 403 for everything. Inside their own organization, a member
     learns nothing from a 404, and "not found" is the truthful answer
     there.
4. **409 `ai_system_name_taken`** on create, rename or un-archive into an
   active name. The database's partial unique index decides, so concurrent
   requests get one 201 and 409s, never a 500 (tested). Unlike an
   organization's slug (TASK-007), only the caller's own organization is
   checked, so a 409 reveals nothing across tenants.
5. **No audit calls in the application.** TASK-008's triggers write every
   event in the same transaction. A second writer could disagree with them,
   or fail on its own.
6. **Six response fields:** `id`, `name`, `description`, `systemType`,
   `provider` and `status` (README §66).
   - The organization isn't repeated, because the client asked under it.
     The timestamps aren't sent either.
   - Rejected: sending `createdAt` and `updatedAt` now. TASK-010 adds them
     if a screen shows them, and removing a field later is harder than
     adding one.
7. **Plain UUIDs**, not README §67's optional `sys_…` IDs. Organizations
   already expose UUIDs, and two ID styles in one API is worse than either.
   Random UUIDs are already unguessable, which is what matters for
   security. Settled on the review: the widget won't expose
   `ai_systems.id`, but will get its own revocable public key.
8. **Strict bodies.**
   - A creation carrying `organizationId`, `id`, `status`, timestamps or any
     unknown field gets a 400, as does an edit carrying `organizationId` or
     `id`.
   - The same text rules as the table: trimmed, length-limited, and no
     control or format characters in names or providers. Descriptions keep
     line breaks and tabs, so `hasControlCharacter` gained an
     `allowLineBreaks` option.
9. **`?status=active|archived|all`, active by default.** A repeated or
   unknown value is a 400, as ambiguous parameters are in the sign-in
   callback.
10. **Lists are capped at 200**, ordered by name then ID, and say so.
    The query asks for 201 rows; if it gets them, the response has the first
    200 and `truncated: true` (review finding 1). There's no pagination until
    an organization gets near that.
11. **Text is normalized to NFC** (review finding 2; owner, 2026-09-21).
    - "Café" typed as `e` plus a combining accent becomes the precomposed
      four characters, so two spellings of one name can't both pass the
      unique index (tested against the real database).
    - This covers system names, providers, descriptions and organization
      names.
    - The length is counted after normalizing, as the table counts it.
    - The database doesn't check NFC yet. Owner's decision: an
      `is nfc normalized` CHECK comes with the next migration that touches
      these tables. Until then, a direct Data API write can still store the
      decomposed form.
12. **Defence in depth on writes.**
    - The route checks `systems.manage`.
    - The query functions refuse an `OrganizationAccess` whose role is too
      low (as in `organization-queries.ts`).
    - RLS refuses again. An RLS refusal (`42501`) caused by a role removed
      between the check and the write is answered 403, not 500.

### Files changed

- `.ai/tasks/TASK-009-ai-systems-api.md` (new): the contract
- `features/ai-systems/ai-system.ts` (new): schemas and the serializer
- `features/ai-systems/ai-system-queries.ts` (new): list, read, create and
  update, each scoped to the organization
- `features/ai-systems/.gitkeep`: removed
- `app/api/organizations/[organizationId]/ai-systems/route.ts` (new): GET
  and POST
- `app/api/organizations/[organizationId]/ai-systems/[systemId]/route.ts`
  (new): GET and PATCH
- `lib/validation/text.ts`: the `allowLineBreaks` option. This is out of
  contract, recorded here.
- Tests:
  - `tests/unit/ai-systems/ai-system.test.ts` (new): 43 tests
  - `tests/security/ai-systems/ai-systems-api.test.ts` (new): 16 tests,
    fake database
  - `tests/unit/organizations/organization.test.ts`: one NFC test
  - `tests/security/ai-systems/ai-systems-api.supabase.ts` (new): 13 tests,
    real database
  - `tests/integration/ai-systems/ai-systems-api.supabase.ts` (new): 8
    tests, real database
- `features/organizations/organization.ts`: NFC. Out of contract, recorded
  in the contract's amendment.

### Security considerations

- Cross-tenant list, read, create, edit and archive fail through the routes
  (403 under B's organization, 404 for B's system under A's). B's row is
  unchanged afterwards.
- A viewer can't write, and is refused before the body is read.
- The organization comes from the authorized route, never from the body.
- Errors carry only a code and a reference. A leaked constraint name or
  SQLSTATE never reaches the client (tested).
- Only the session client is used. The service role can't write AI systems
  (TASK-008).

### Tests

- Required by the contract: all covered.
- Mutation checks, each reverted:
  - reading one system by ID alone fails 1 test in the fake suite; the real
    database still answers 404, because RLS hides B's system;
  - updating by ID alone does the same;
  - a non-strict creation body fails 6 fake-suite and 4 real-database tests;
  - dropping the `23505` mapping fails 1 fake-suite and 2 real-database
    tests;
  - dropping NFC fails 3 unit tests and 1 real-database test;
  - a `truncated` that is always false fails 1 fake-suite test.
- The first two show the layering. The application's organization filter
  and RLS each stop the leak on their own, so the fake suite is what
  guards the application's layer.

### Commands run

See the PR. Each gate was run with the owner's untracked
`CODEX-SECURITY.md` set aside and restored, and its hash verified.

### Remaining concerns

- **A database NFC check** is owed with the next migration that touches
  `ai_systems` or `organizations` (owner's decision).
- **For the widget phase:**
  - The widget should not expose `ai_systems.id`. It should get its own
    public key, which can be rotated or revoked without touching the
    system (review).
  - Descriptions keep Unicode format characters on purpose, since they're
    prose. Public text must therefore be rendered in direction-isolating
    markup (`dir="auto"` or `<bdi>`), so one right-to-left override can't
    reorder the page around it (review finding 4).
- **A role lowered between the check and an edit** is answered 404, not
  403, because RLS on update filters rather than errors. The edit is
  refused either way, and leaks nothing. The code comment now says so
  (review finding 3).
