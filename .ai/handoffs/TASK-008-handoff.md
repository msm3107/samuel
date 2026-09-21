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
   trigger sets both, even for the table owner, and the shared
   `private.set_updated_at` keeps `updated_at` on update.
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

### Files changed

- `supabase/migrations/20260921160000_ai_systems.sql` (new)
- `supabase/tests/ai_systems.test.sql` (new): pgTAP, 26 tests
- `tests/security/tenant-isolation/ai-systems.supabase.ts` (new): 20
  tests, real database
- `tests/integration/database/ai-systems.supabase.ts` (new): 6 tests, real
  database
- `.ai/tasks/TASK-008-ai-systems-schema.md` (new): the contract, with the
  owner's four decisions

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
  - a name index over archived systems too fails 1, plus 3 pgTAP tests.

### Commands run

See the PR. Each gate was run with the owner's untracked
`CODEX-SECURITY.md` set aside and restored, and its hash verified.

### Remaining concerns

- **No audit yet.** `ai_system.created` is recorded by TASK-009's service.
  An insert made directly through the Data API bypasses it. This is the
  TASK-006 model: the recorder is the application's, and a user writing
  directly leaves no event. If that's not acceptable, TASK-009 can move
  creation into a database function, as TASK-007 did.
- **README §5 lists no length limits.** The ones above (120, 2000, 100) are
  mine and cheap to relax, since relaxing a CHECK needs no data change.
