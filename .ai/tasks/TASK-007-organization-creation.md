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

## Forbidden files

- supabase/migrations/**
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
