## Handoff

### Summary

`public.deployments` exists: the hostnames where an organization's AI
systems are publicly deployed, with RLS confining each to its organization.
No application code uses it yet; TASK-012 to TASK-015 build on it.

There was no TASK-011 contract, so this task adds one. Three decisions were
the owner's (Mikołaj Smoliniec, 2026-09-22). The implementer proposed four
more, which await the owner.

### Decisions

1. **A hostname is unique per AI system**, among active deployments. Owner's
   choice, as the plan says.
   - Why: two systems can share a site (a chatbot and a voice agent on one
     page), and the verifier will prove who really has the widget there.
   - Rejected: across all customers, where anyone could squat a real
     owner's site and "taken" would reveal another customer's site. Also
     rejected: per organization, which forbids the shared page above.
   - Downside: two organizations can both register one site. That is
     harmless until verification, which checks for each one's own
     deployment ID.
2. **The hostname and AI system are fixed after creation.** Owner's choice.
   - A trigger refuses a change from any writer; the column grants already
     stop users.
   - Why: a verification check will point at a deployment, and must always
     mean the site and system it checked.
   - Downside: a typo is fixed by archiving and registering again.
3. **No deployment is created or restored under an archived AI system.**
   Owner's choice.
   - Archiving the system leaves its deployments alone; nothing changes
     that the person didn't touch.
   - The check is an after-insert and after-restore trigger, so RLS has
     already refused an outsider. Someone outside the organization can't
     use it to learn whether a system there is archived (tested).
   - It locks the system row (`for share`). Without that, a registration
     could read the system as active while an archive of it was committing,
     and land under an archived system. A test holds an archive open in a
     second session and shows the registration waits, then is refused.
4. **The database checks a hostname's shape, not its safety.** Proposed.
   - The CHECK wants lowercase ASCII labels of 1 to 63 characters, 253 in
     all, at least two labels, and a last label with a letter. IDN labels
     arrive already punycode-encoded.
   - That alone refuses every IP literal, `localhost`, ports, paths,
     schemes and credentials. So even a bug in TASK-012 can't store one.
   - Well-formed but unsafe names are TASK-012's to refuse, and Phase 7
     checks again when resolving.
   - Rejected: the whole SSRF list in SQL. It would be a second validator,
     which the plan warns against, and a CHECK can't resolve DNS.
5. **Status is `active | archived`**, as for AI systems (README §33).
   Proposed.
6. **Audit by trigger**, as for AI systems. Proposed.
   - The events are `deployment.created`, `deployment.archived` and
     `deployment.unarchived`, all without metadata, so the hostname stays
     out of the audit log.
   - The service role can't write deployments, because an event needs an
     actor.
7. **The public identifier waits for TASK-014.** Proposed. Adding it then,
   with a generated default, fills existing rows; adding it now would fix
   its format before that task decides it.

### Files changed

- `.ai/tasks/TASK-011-deployments-schema.md` (new): the contract
- `supabase/migrations/20260922120000_deployments.sql` (new): the table,
  indexes, triggers, grants, policies, and two audit event types
- `features/organizations/audit/audit-events.ts`: `deployment.archived`,
  `deployment.unarchived`
- Tests:
  - `supabase/tests/deployments.test.sql` (new): 64 pgTAP tests
  - `tests/security/tenant-isolation/deployments.supabase.ts` (new): 25
    tests, real database
  - `tests/integration/database/deployments.supabase.ts` (new): 11 tests,
    real database, one of them the archive race
  - `tests/unit/audit/audit-events.test.ts`: the two new event types

### Security considerations

- Organization B's deployments can't be read, listed, found by hostname,
  created, archived or moved into from A. B's rows are unchanged afterwards.
- A deployment in A can't point at B's system: the composite foreign key
  refuses it with the same error as a system that doesn't exist, so this
  reveals nothing about B.
- Viewers read; members and up write; nobody deletes but the service role,
  and the service role can't insert or change a deployment either (no
  actor).
- A soft-deleted organization's deployments can't be read or written.
- No new security definer function besides the audit trigger, which writes
  only its own fixed rows.

### Tests

- Required by the contract: all covered.
- Mutation checks, each reverted:
  - the archived-system check without `for share`: the race test fails;
  - no archived-system check: 2 real-database tests and pgTAP fail;
  - the guard letting the hostname change: pgTAP fails. The Data API tests
    still pass, because the column grant stops users anyway; the guard is
    for the service role;
  - the audit skipping archive and restore: 2 real-database tests and pgTAP
    fail;
  - the hostname check without its letter rule (so IPv4 literals pass): 1
    real-database test and pgTAP fail;
  - the insert policy admitting viewers: 1 security test fails;
  - hostnames unique per organization instead of per system: 1
    real-database test and pgTAP fail.

### Commands run

See the PR. Each gate was run with the owner's untracked
`CODEX-SECURITY.md` set aside and restored, and its hash verified.

### Remaining concerns

- **The race test runs `psql` in the database container**
  (`supabase_db_article50`, from `project_id`). It needs Docker, which the
  real-database suites already do; renaming the project breaks it.
  Rejected: adding a Postgres client dependency for one test.
- **A system archived and restored** leaves its deployments as they were.
  The person restores the archived ones by hand; that's intended.
- **Deploy to production:** this PR has a migration. Merging to `main`
  applies it to the production database.
- **Owed from earlier tasks, unchanged:** the database NFC check with the
  next migration on `ai_systems` or `organizations` (this one touches
  neither); the widget's own revocable key and direction-isolated
  rendering.
