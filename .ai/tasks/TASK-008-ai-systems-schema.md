# TASK-008 — AI systems schema and RLS

## Objective

Create `ai_systems`, the AI systems an organization discloses (README §5),
with the row-level security that confines each system to its organization.
Services and routes are TASK-009; dashboard screens are TASK-010.

## Owner agent

Database

## Dependencies

TASK-004 (organizations, memberships, `authz.has_org_role`), TASK-005 (the
`systems.manage` permission: member and up), TASK-006 (`ai_system` is already
an audit entity type).

## Allowed files

- supabase/migrations/** — one new migration only
- supabase/tests/**
- tests/security/tenant-isolation/**
- tests/integration/database/**

## Decisions

Decided by Mikołaj Smoliniec (project owner), 2026-09-21:

- **Status** is `active | archived`. There is no delete for users: archiving
  keeps the deployments, verification history and reports that will point
  at a system. Only the service role deletes, as for organizations.
- **Provider** is optional free text: trimmed, 1 to 100 characters, no
  control characters.
- **Names** are unique within an organization among active systems,
  case-insensitively. An archived system's name can be reused.
- **Writers** are members and up, matching `systems.manage`. Viewers read.
- **Length limits** of 120 (name), 2000 (description) and 100 (provider)
  characters, proposed by the implementer. Accepted by Mikołaj Smoliniec
  (project owner), 2026-09-21.

## Amendment: the PR #22 review

Decided by Mikołaj Smoliniec (project owner), 2026-09-21:

- **Auditing by trigger.** An after-insert and an after-update trigger write
  `ai_system.created`, `ai_system.updated` (the changed column names, never
  their values), `ai_system.archived` and `ai_system.unarchived` in the same
  transaction as the change, however it was written. A write with no
  signed-in user, the service role's included, is refused so every event has
  an actor. This adds three event types to `audit_events`' CHECK constraint
  and to `features/organizations/audit/audit-events.ts`.
- **Format characters.** AI system names and providers, and organization
  names, refuse Unicode format characters other than the zero-width joiner.
  For organizations this is a second new migration that adds a table
  constraint and replaces `create_organization`, and the name schema in
  `features/organizations/organization.ts` changes to match.
- **Fixed after insert.** A trigger keeps `created_at`, `id` and
  `organization_id` unchanged for every writer short of the table owner
  disabling it (review finding 3).

Files this adds beyond the list above, recorded here. **The allowed-files
list, original and amended, still awaits the owner's sign-off** (review
finding 4):

- `supabase/migrations/20260921170000_name_format_characters.sql` (new)
- `features/organizations/audit/audit-events.ts`: three event types
- `features/organizations/organization.ts`: format characters refused
- `lib/validation/text.ts` (new): the shared character checks; the empty
  folder's `.gitkeep` removed
- `tests/unit/audit/audit-events.test.ts`: the drift test reads the latest
  definition of each constraint across all migrations
- `tests/unit/validation/text.test.ts` (new)
- `supabase/tests/create_organization.test.sql`: two tests

## Forbidden files

- Existing migrations, tables, policies and grants, except as amended above
- lib/** and features/**, except the files amended above
- app/**

## Invariants

- `organization_id uuid not null` with a foreign key; RLS enabled in the same
  migration that creates the table.
- `system_type` is a check constraint allowing exactly `chatbot`,
  `voice_agent`, `assistant`, `generator` and `other`.
- Access resolves through `authz.has_org_role`, so no one can read or write
  a soft-deleted organization's systems.
- A system can never move to another organization: `organization_id` is not
  updatable.
- `id`, `created_at` and `updated_at` are the database's, not the caller's.
- `(organization_id, id)` is unique, so later tables (deployments,
  disclosures) can use a composite foreign key that guarantees a child row
  belongs to the same organization as its system.

## Acceptance criteria

- `supabase db reset` applies the migration cleanly.
- Cross-tenant read, write and enumeration fail through RLS, proven against
  the real database.
- A viewer cannot write; nobody but the service role can delete.
- A duplicate active name fails with a unique violation, deterministically.
- Typecheck, lint, format, and tests pass.

## Required tests

- security: user A cannot read, insert into, update, or enumerate
  organization B's systems
- security: a viewer cannot insert or update; no signed-in user can delete
- security: `organization_id`, `id`, `created_at` cannot be set or changed
  by a user
- security: a soft-deleted organization's systems are not readable
- integration: create, update, archive, and name reuse after archiving
- database (pgTAP): constraints, the composite unique key, the
  `updated_at` trigger
