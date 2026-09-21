# TASK-007 — Organization creation and the tenant-isolation suite

## Objective

Let an authenticated user create an organization and become its owner
atomically, and prove the tenant boundary holds through application code as
well as through RLS.

## Owner agent

Backend, then Testing

## Dependencies

TASK-004, TASK-005, TASK-006, and TASK-003i: this is the first route handler
that resolves a session, and without 003i an auth-server 429 during its
session refresh would delete the person's session (review finding F2).

## Allowed files

- features/organizations/**
- app/api/organizations/**
- app/(dashboard)/**
- tests/integration/organizations/**
- tests/security/tenant-isolation/**

## Amendment: one migration

Approved by Mikołaj Smoliniec (project owner), 2026-09-21. Creating an
organization together with its owner membership needs one transaction. The
Data API cannot run two inserts in one transaction, so it needs a database
function. This task may add exactly one migration, holding only that
function.

Open for this task: whether the function also writes the
`organization.created` and `member.added` audit rows in the same
transaction, or whether the route records them afterwards with
`recordAuditEvent` (TASK-006).

- In the transaction: the rows can't be missed, but an audit failure then
  fails the creation.
- Afterwards: follows TASK-006's rule that auditing never fails the action,
  but a crash between the two steps loses the rows.

- Allowed: one new file in `supabase/migrations/`, for the
  create-organization function.
- Still forbidden: changing any existing migration, table, policy or grant.

## Forbidden files

- supabase/migrations/** (except the one migration above)
- lib/auth/**
- lib/security/**

## Invariants

- Creating the organization and its owner membership is one transaction. A
  partial failure must not leave an organization with no owner.
- The creating user's identity comes from `requireSession()`. The request body
  carries a name only — never a `userId`, `role`, or `organizationId`.
- The slug is generated server-side and uniqueness-checked in the database, not
  by a read-then-write that two concurrent requests can both pass.
- Both `organization.created` and the owner membership are audited.
- The response is an explicit serializer: `id`, `name`, `slug`. No internal
  columns (§66).
- Route order is `authenticate → authorize → validate → execute → serialize`.

## Open questions from the TASK-004 review, for the owner

- **Slugs are unique across every tenant**, including soft-deleted ones. A
  creation form that says "slug taken" reveals that another organization uses
  it, the kind of enumeration README §8 forbids. Decide whether slugs are
  public (they would appear in URLs anyway), or whether creation picks a
  free slug itself and never reports a collision.
- **Reserved slugs.** Words that are, or may become, routes (`dashboard`,
  `api`, `admin`, `sign-in`, `settings`, …) should be refused before the first
  organization can take one.

## Acceptance criteria

- A signed-in user can create an organization and is its owner.
- Two concurrent requests for the same slug produce one organization and one
  deterministic error, not two rows or a 500.
- Every §8 isolation check fails through the API route, not only through RLS.
- `pnpm test:security` runs real assertions; `--passWithNoTests` is removed
  from the script in this task.
- Typecheck, lint, format, and tests pass.

## Required tests

- integration: creation succeeds and yields an owner membership
- integration: concurrent slug collision resolves deterministically
- integration: a failure after organization insert leaves no ownerless row
- security: user A cannot read, update, or enumerate organization B via the API
- security: user A cannot generate reports or act for organization B
- security: an unauthenticated creation request fails
