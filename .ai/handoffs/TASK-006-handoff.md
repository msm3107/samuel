## Handoff

### Summary

`public.audit_events`, an append-only record of security-sensitive actions,
and `recordAuditEvent`, which validates an event per type and writes it
server-side without ever failing the action it describes.

### Decisions

1. **Only the service role inserts.** `authenticated` can only read.
   - Rejected: an insert grant with an RLS check that the actor is the
     caller.
   - Why: any member could then call the Data API directly and write
     `billing.plan_changed` or `member.role_changed` rows that never
     happened. An audit log users can forge proves nothing.
   - The service-role rule allows this: the session client cannot serve
     this safely, so the service role is not taking over a request a session
     client could serve.
   - Downside: every write goes through the one server-side function, which
     is also what makes the Zod validation unavoidable.
2. **The recorder takes an `OrganizationAccess`**, the result of
   `requireOrganizationRole()`, not a user ID and an organization ID.
   - Why: the actor and the organization recorded are the ones the request
     was authorized for.
   - Rejected: calling `requireSession()` inside the recorder. Outside a
     server render that is a second auth-server round trip on every event.
   - `OrganizationAccess` is branded (review note 4), so a hand-built
     object, such as `{ userId: formData.get("userId"), … }`, does not
     compile. Only `requireOrganizationRole()` makes one. A
     `@ts-expect-error` test keeps it that way.
   - Tests build one through `tests/support/organization-access.ts`, the one
     deliberate cast.
   - Downside: a cast still gets past it, as with any TypeScript type.
3. **Append-only for every role.** Four layers:
   - No grant gives anyone update, delete or truncate, the service role
     included.
   - A trigger refuses update and delete, even for the table owner, unless
     they disable it.
   - A statement trigger refuses truncate.
   - The one way rows disappear is deleting their organization (cascade).
     The trigger allows a delete only when both hold:
     `pg_trigger_depth() > 1`, because the cascade runs inside the foreign
     key's own trigger, and the organization row no longer exists. Depth
     alone would also admit a delete issued by any other trigger (review
     note 2).
   - What this does not protect against: someone with database-owner
     access, who can disable the trigger or set
     `session_replication_role = replica` (review note 3). It protects
     history from the application, its users and the service-role key. It is
     not tamper-proof. Tamper evidence, such as hash-chained rows or a copy
     in external storage, is a Phase 12 question.
   - Rejected: `on delete restrict`. Test clean-up and any future retention
     job would then need to delete audit rows one by one, which is exactly
     what should be impossible.
   - Why cascade is acceptable: only the service role can delete an
     organization at all, and organizations are soft-deleted (README §33).
   - Downside: hard-deleting an organization erases its history. That
     belongs in the retention policy README §33 asks for before launch.
4. **No foreign key on `actor_user_id`.**
   - A key would force one of three things when a user is deleted: block the
     deletion (restrict), erase their history (cascade), or rewrite it
     (set null, which is an update the trigger would refuse anyway).
   - The UUID alone is pseudonymous.
5. **Strict metadata with no free text.** Each type's metadata is a
   `z.strictObject` of enums only. Most types carry nothing.
   - This keeps tokens, headers, payment data and personal information out
     by construction: there is no field for them to land in.
   - Member events name the membership (`entity_id`), never the member's
     user ID or email.
   - Rejected: a denylist that scans keys for words like "token". It misses
     whatever it doesn't list.
   - Downside: a future event needing a detail requires a schema change.
     That is intended.
6. **The type set is a CHECK constraint.** A test reads the migration and
   asserts its list equals `AUDIT_EVENTS`, so the two cannot drift.
   - Rejected: a Postgres enum. A value added with `alter type … add value`
     can't be used in the same transaction that adds it, and a value can
     never be removed. A CHECK constraint is dropped and re-added in one
     statement pair.
   - `member.invited` describes an `invitation`, not a membership (review
     note 6). Invitations will have their own table, and deciding now, while
     no rows exist, saves a migration.
   - Types added beyond README §6's examples:
     - `member.added`: TASK-007 audits the owner membership.
     - `member.removed`: carries `how: left | removed`, for the leave path.
7. **`entity_type` is derived from the event type**, never passed by the
   caller. `billing.plan_changed` describes the organization.
8. **The database sets `created_at`** with a trigger, whatever the writer
   sends. Metadata must be a JSON object of at most 2048 bytes (CHECK).
9. **Reading: owners and admins only**, and only for a live organization,
   through `authz.has_org_role`.
   - Rejected: every member. Audit history shows who changed whose role,
     which is the same boundary as the member list (owners and admins).
   - Downside: if members should see some activity, that becomes a view
     later.
10. **Recording never throws.** On any failure it logs
    `audit_event_not_recorded` at error level with the event type, the
    organization and the error code, never the metadata. It returns
    `{ recorded: false }`. An unknown type from a cast is logged as
    `"unknown"`, not echoed.
11. **Where the code lives: `features/organizations/audit/`,** as the
    contract says.
    - Audit is cross-feature, so if `ai_system.created` and the other
      events' callers find the path odd, moving it to `lib/audit/` is a
      rename, not a redesign.

### Files changed

- `supabase/migrations/20260921140000_audit_events.sql` (new)
- `features/organizations/audit/audit-events.ts` (new): types, schemas,
  and building the row
- `features/organizations/audit/record-audit-event.ts` (new)
- `features/organizations/.gitkeep`: removed, the folder now has files
- `tests/unit/audit/audit-events.test.ts` (new): 112 tests
- `tests/security/audit/record-audit-event.test.ts` (new): 7 tests
- `tests/security/audit/audit-events.supabase.ts` (new): 16 tests, real
  database
- `tests/integration/audit/record-audit-event.supabase.ts` (new): 3 tests,
  real database
- `supabase/tests/audit_events_append_only.test.sql` (new): pgTAP, 9 tests
- `package.json`: the `test:db` script
- `.github/workflows/e2e.yml`: a pgTAP step in the existing database job,
  so no new required check
- `lib/auth/require-organization-role.ts`: `OrganizationAccess` is branded
- `tests/support/organization-access.ts` (new): the test-only way to make
  one
- `vitest.supabase.config.ts`: now `tests/**/*.supabase.ts`. This is an
  amendment in the contract.
- `.ai/tasks/TASK-006-audit-events.md`: the amendment
- `.ai/tasks/TASK-007-organization-creation.md`: one migration allowed,
  approved in chat. Whether audit rows are written in the same transaction
  is left open for TASK-007.

### Security considerations

- Users cannot insert, update or delete audit rows. The service role
  cannot update or delete them either.
- Cross-tenant reads return nothing. Members and viewers read nothing.
- No personal data beyond `actor_user_id`, no free text, and no metadata in
  logs.

### Tests

- Required by the contract:
  - an event is recorded with the correct actor and organization;
  - update and delete are refused;
  - a cross-tenant read fails;
  - a token-shaped field is rejected. That was checked for 8 key names
    across all 10 types, plus token-shaped values.
- Mutation checks, each reverted:
  - opening the read policy to everyone fails 3 tests;
  - granting update and delete to `authenticated` fails 2;
  - disabling the `created_at` trigger fails 1;
  - replacing `strictObject` with `object` fails 82.
- The grants hide the append-only trigger from every role the Vitest
  suites can use. So `supabase/tests/audit_events_append_only.test.sql`
  (pgTAP, run by `pnpm test:db` and in CI's database job) tests it as the
  table owner (review note 1). It has 9 tests:
  - update, direct delete and truncate are refused;
  - a delete from another trigger is refused while the organization exists;
  - an organization delete cascades to its own rows only;
  - `created_at` is set by the database.
- Mutation checks on the pgTAP suite:
  - allowing a delete on depth alone fails 3 tests;
  - dropping the triggers fails 5.
- A type-level mutation check: removing the `OrganizationAccess` brand
  fails `pnpm typecheck`.

### Commands run

See the PR. Each gate was run with the owner's untracked
`CODEX-SECURITY.md` set aside and restored, and its hash verified.

### Remaining concerns

- **A failed audit write is only logged, so an event can go missing.**
  Proposed for Phase 12: an alert on `audit_event_not_recorded`, at least for
  billing and ownership events. Accepted by Mikołaj Smoliniec (project
  owner), 2026-09-21.
- **Hard-deleting an organization erases its audit history.** The retention
  policy (README §33) must decide how long audit rows live. Today they live
  exactly as long as their organization row. Accepted by Mikołaj Smoliniec
  (project owner), 2026-09-21.
- Nothing records events yet. TASK-007 is the first caller.
