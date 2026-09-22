# TASK-011 — Deployments schema and RLS

## Objective

Create `deployments`, the hostnames where an organization's AI systems are
publicly deployed (README §5), with the row-level security that confines each
deployment to its organization. Hostname validation in the application is
TASK-012, services and routes TASK-013, the public identifier TASK-014, and
the screen TASK-015.

## Owner agent

Database

## Dependencies

TASK-008 (`ai_systems` and its `(organization_id, id)` key), TASK-005 (the
`deployments.manage` permission: member and up), TASK-006
(`deployment.created` is already an audit event type).

## Allowed files

- supabase/migrations/**: one new migration only
- supabase/tests/**
- tests/security/tenant-isolation/**
- tests/integration/database/**
- features/organizations/audit/audit-events.ts: two event types
- tests/unit/audit/audit-events.test.ts: the same two

## Forbidden files

- Existing migrations, tables, policies and grants, except `audit_events`'
  event type CHECK, which gains two types
- lib/** and app/**
- features/**, except the file above

## Decisions

Decided by Mikołaj Smoliniec (project owner), 2026-09-22:

- **A hostname is unique per AI system**, among active deployments. Two
  systems can share a site, and two organizations can both name one; the
  verifier (Phase 7) proves who has the widget there.
  - Rejected: unique per organization, which stops one site from hosting
    two of a customer's systems.
  - Rejected: unique across all customers. Anyone could register a real
    owner's site first and block them, and a "taken" answer would tell a
    stranger another customer uses that site.
- **The hostname and AI system are fixed** once a deployment is created. To
  change either, archive it and register again. Verification history then
  always means the same site and system.
- **No deployment is created or restored under an archived AI system.**
  Archiving a system leaves its deployments as they are; the verifier will
  skip them. Rejected: archiving them along with the system, which changes
  rows the person never looked at.

Proposed by the implementer; all four accepted on the PR #25 review.
Accepted by Mikołaj Smoliniec (project owner), 2026-09-22.

- **The database checks a hostname's shape, not its safety.**
  - The shape: lowercase ASCII, IDN labels already punycode, no trailing
    dot, labels of 1 to 63 characters, 253 in all, at least two labels, and
    a last label that starts with a letter (amended on the PR #25 review).
  - That shape alone refuses every IP literal (`127.0.0.1`, `0x7f.1`,
    `127.0.0.0x1`, `[::1]`), `localhost` and every other single-label name,
    ports, paths, schemes and credentials.
  - Names that are well-formed but unsafe (`metadata.google.internal`, a
    name that resolves to a private address) are refused by
    `lib/security/verification-target.ts` (TASK-012) and again when the
    verifier resolves them (Phase 7).
  - Why not the whole list in SQL: it would be a second SSRF validator,
    which the plan names as the failure mode to avoid, and resolution can't
    happen in a CHECK anyway.
- **Status is `active | archived`**, as for AI systems. Users archive
  (README §33: archive a deployment, keep its verification history).
- **Creation, archive and restore are audited by trigger**, as for AI
  systems.
  - The events are `deployment.created`, plus the new `deployment.archived`
    and `deployment.unarchived`.
  - None carries metadata, so the hostname stays out of the audit log.
  - A write with no signed-in user, the service role's included, is
    refused.
- **The public deployment identifier is TASK-014's column.** Its migration
  can add the column with a generated default, which fills the rows that
  already exist.

## Amendment: the PR #25 review

Decided by Mikołaj Smoliniec (project owner), 2026-09-22:

- **The top-level label must start with a letter** (finding 1). The first
  version only required it to contain one, which let hexadecimal IPv4 forms
  through: `127.0.0.0x1` and `169.254.169.0xfe`, which URL parsers (fetch's
  included) read as `127.0.0.1` and the cloud metadata address. Every real
  top-level domain starts with a letter. Rejected: keeping the rule and
  saying "most IP addresses", which would leave TASK-012 without its
  backstop.
- **No one deletes a deployment** (finding 3), the service role and the
  table owner included, except by deleting its organization or AI system.
  A row trigger refuses the delete while both still exist, and a statement
  trigger refuses `truncate`. Verification history will cascade from
  deployments (Phase 7), and README §33 says to keep it. Rejected: an
  audit trigger on delete, which records the loss but doesn't prevent it.
- Not taken: writing into later contracts that the widget key, verifier and
  public pages check the AI system's status as well (finding 2), and
  reading the database container's name from `supabase status` in the
  race test (finding 4). Both are recorded in the handoff.

## Invariants

- `organization_id uuid not null` with a foreign key. RLS is enabled in the
  same migration that creates the table.
- `(organization_id, ai_system_id)` references the same pair on
  `ai_systems`, so a deployment can't point at another organization's
  system.
- `(organization_id, id)` is unique, for verification checks' composite
  foreign key (Phase 7).
- Access resolves through `authz.has_org_role`: viewers read, members and up
  write, and no one reaches a soft-deleted organization's deployments.
- A user sets `organization_id`, `ai_system_id` and `hostname` on insert, and
  only `status` afterwards. There is no delete grant, and a trigger refuses
  any other writer's delete unless the organization or AI system is being
  deleted.
- `id`, `organization_id`, `ai_system_id` and `hostname` never change, for
  any writer short of the table owner disabling the trigger. `created_at`
  and `updated_at` are the database's.
- The archived-system check runs after RLS, so it never reports on another
  organization's system. It locks the system row, so it can't pass while an
  archive of that system commits.

## Acceptance criteria

- `supabase db reset` applies the migration cleanly.
- Cross-tenant read, write and enumeration fail through RLS, proven against
  the real database.
- A viewer cannot write. No one deletes a deployment except by deleting its
  organization or AI system (amended on the PR #25 review).
- A duplicate active system and hostname pair fails with a unique
  violation, deterministically, including under concurrent inserts.
- Typecheck, lint, format, and tests pass.

## Required tests

- security: user A cannot read, insert into, archive, or enumerate
  organization B's deployments, or attach one to B's system
- security: a viewer cannot insert or archive; no signed-in user can delete
- security: `id`, `organization_id`, `ai_system_id`, `hostname`,
  `created_at` and `status` (on insert) cannot be set or changed by a user
- security: a soft-deleted organization's deployments are neither readable
  nor writable
- integration: register, archive, restore, re-register an archived
  hostname, the archived-system rule, a concurrent registration race, and a
  registration racing an archive of its system
- database (pgTAP): hostname shapes accepted and refused, constraints, the
  composite keys, the triggers, audit events
