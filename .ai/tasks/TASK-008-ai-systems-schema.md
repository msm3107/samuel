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

## Forbidden files

- Existing migrations, tables, policies and grants
- lib/**
- features/**
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
