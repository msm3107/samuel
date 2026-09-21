## Handoff

### Summary

`public.ai_systems`, the AI systems an organization discloses, with
row-level security that confines each system to its organization. Members
and up create and edit; viewers read; nobody but the service role deletes.
Services and routes are TASK-009.

### Decisions

1. **Archive, never delete** (owner, 2026-09-21). `status` is `active` or
   `archived`, and `authenticated` has no delete grant.
   - Why: deployments, verification history and reports will point at a
     system. A delete would either cascade that evidence away or be blocked
     by it.
   - Rejected: a `draft` state, which later phases would have to handle for
     no gain yet.
   - Downside: a mistaken system stays, archived. The service role can
     still hard-delete, as for organizations.
2. **Names are unique among active systems, ignoring case** (owner).
   - The index is `ai_systems_active_name_key`:
     `(organization_id, lower(name))`, partial, active rows only.
   - The index decides, so five concurrent creations of one name produce
     one row and four `23505`s (tested).
   - A "taken" answer leaks nothing across tenants: only the caller's own
     organization is checked.
   - Unarchiving into a taken name fails the same way, so TASK-009 must
     map `23505` on both create and update.
3. **Provider is optional free text**, 1 to 100 characters, trimmed, no
   control characters (owner). Rejected: a vendor list, which would go stale.
4. **Writers are members and up** (owner), matching `systems.manage` from
   TASK-005, so the RLS and the application's permission table agree.
5. **Column grants decide what a user may set:**
   - insert: `organization_id`, `name`, `description`, `system_type`,
     `provider`;
   - update: `name`, `description`, `system_type`, `provider`, `status`.
   - So `id`, the timestamps and a starting status are never the client's,
     and a system can never move to another organization. `organization_id`
     is not updatable at all, rather than only checked by the policy.
6. **The database sets `created_at` and `updated_at`.** A before-insert
   trigger sets both, and the shared `private.set_updated_at` keeps
   `updated_at` on update. A before-update guard keeps `created_at`, `id`
   and `organization_id` unchanged for every writer, the service role
   included (review finding 3). The table owner can still disable triggers;
   nothing here protects against database-owner access, as with
   `audit_events`.
7. **`unique (organization_id, id)`.** Deployments and disclosures can then
   declare a composite foreign key from `(organization_id, ai_system_id)`
   to `ai_systems (organization_id, id)`. A child row then cannot sit in one
   organization and point at another's system, whatever the application
   does. It is also the index for systems by organization.
8. **Text rules:**
   - The name is one line, 1 to 120 characters, trimmed.
   - The description may have line breaks and tabs, up to 2000 characters,
     but no other control characters.
   - The same rules will be repeated in Zod in TASK-009, as for
     organization names.
9. **Access goes through `authz.has_org_role`**, like the other tables. A
   soft-deleted organization's systems can't be read or written, even by
   its owner (tested).
10. **Every change is audited by trigger** (owner, on review finding 1).
    - Events: `ai_system.created`, `ai_system.updated`,
      `ai_system.archived`, `ai_system.unarchived`. They are written in the
      same transaction as the change, whether it came through the
      application or straight through the Data API.
    - `ai_system.updated` carries `{"fields": [...]}`: the changed column
      names, never their values, because the audit log holds no free text.
      An update that changes nothing audited writes nothing. Archiving
      while renaming writes both events.
    - A write with no signed-in user, including the service role's, is
      refused, so every event has an actor. A refused audit write undoes
      the change (tested).
    - Rejected: a creation function like `create_organization`, which is
      just as airtight but replaces a plain insert and the RLS that governs
      it. Also rejected: the application's recorder, which a direct Data
      API write skips.
    - Downsides: audit logic now lives in the database as well as in
      `recordAuditEvent`, and the service role cannot create or edit
      systems (a future admin or support tool would need a user to act as).
    - The trigger function is `security definer`, because users have no
      insert grant on `audit_events`. It writes only these rows, with the
      actor taken from the JWT, never from the row, and no user can call it
      directly (pgTAP).
    - The three new event types extend `audit_events`' CHECK constraint and
      `AUDIT_EVENTS`. The drift test now reads each constraint's latest
      definition across all migrations.
11. **Invisible Unicode format characters are refused** (owner, on review
    finding 2; also closes #21's finding 4).
    - This covers AI system names and providers, organization names in
      `create_organization`, and the `organizations` table itself, which
      had no character check at all, so a rename could store a control
      character.
    - The zero-width joiner stays allowed for emoji and some scripts.
    - Postgres regular expressions have no `\p{Cf}`, so the 22 ranges
      (Unicode 16.0) are written out. A unit test compares them with
      JavaScript's `\p{Cf}` over every code point, and checks that all four
      copies in the migrations are identical. `lib/validation/text.ts`
      holds the application's side, now used by the organization name
      schema and later by TASK-009's system schema.
    - Downside: the ranges are frozen at Unicode 16.0. When Node's Unicode
      version adds Cf characters, the drift test fails and names the code
      points to add.

### Files changed

- `supabase/migrations/20260921160000_ai_systems.sql` (new)
- `supabase/tests/ai_systems.test.sql` (new): pgTAP, 42 tests
- `tests/security/tenant-isolation/ai-systems.supabase.ts` (new): 20
  tests, real database
- `tests/integration/database/ai-systems.supabase.ts` (new): 9 tests, real
  database
- `supabase/migrations/20260921170000_name_format_characters.sql` (new):
  the organizations constraint and `create_organization` with format
  characters refused
- `supabase/tests/create_organization.test.sql`: 2 more tests (29)
- `features/organizations/audit/audit-events.ts`: three event types
- `features/organizations/organization.ts`: the name schema refuses format
  characters
- `lib/validation/text.ts` (new), `lib/validation/.gitkeep` removed
- `tests/unit/audit/audit-events.test.ts`: the latest constraint definition,
  and the new types
- `tests/unit/validation/text.test.ts` (new): 18 tests
- `.ai/tasks/TASK-008-ai-systems-schema.md` (new): the contract, the owner's
  decisions and the review amendment

### Security considerations

- Cross-tenant read, insert, update, enumeration and moving a system into
  another organization all fail through the Data API as real signed-in
  users.
- A viewer can't write. Nobody signed in can delete. The anon key reads and
  writes nothing.
- No personal data: systems describe software, not people.

### Tests

- Required by the contract: all covered.
  - Cross-tenant read, insert, update and enumerate.
  - Viewer insert and update; delete by owner, member and viewer.
  - Setting `id`, `created_at`, `updated_at` or `status` on insert, and
    `id` or `created_at` on update.
  - A soft-deleted organization's systems.
  - Create, edit, archive, reuse of an archived name, and a concurrent
    duplicate.
  - pgTAP: constraints, the composite unique key, the triggers and the
    privileges.
- Mutation checks, each reverted:
  - a read policy open to everyone fails 3 tests;
  - letting viewers insert fails 1;
  - granting delete fails 3, plus a pgTAP test;
  - a name index over archived systems too fails 1, plus 3 pgTAP tests;
  - dropping the insert audit trigger fails 2, plus 5 pgTAP tests;
  - letting a write with no user through fails 1, plus a pgTAP test;
  - dropping the update guard fails 3 pgTAP tests;
  - letting format characters into names fails a pgTAP test and the drift
    test.

### Commands run

See the PR. Each gate was run with the owner's untracked
`CODEX-SECURITY.md` set aside and restored, and its hash verified.

### Remaining concerns

- **The allowed-files list awaits the owner's sign-off** (review finding 4).
  The length limits were accepted by Mikołaj Smoliniec (project owner),
  2026-09-21.
- **TASK-009 must map the database's refusals**: `23505` on create and on
  un-archive, `23514` for a value its Zod schema should have caught, and
  `42501` from RLS.
- **The production migration adds a constraint to `organizations`**, which
  checks existing rows. A production organization whose name already holds
  a control or format character would make the migration fail, and nothing
  would be applied. Unlikely with the few organizations there, but check
  the deploy.
