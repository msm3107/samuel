# TASK-004 — Organizations and memberships schema

## Objective

Create the tenant-safe baseline every later table copies: organizations, the
memberships that resolve users to them, and the RLS that enforces both.

## Owner agent

Database

## Dependencies

TASK-001.

## Allowed files

- supabase/migrations/**
- supabase/seed.sql
- tests/integration/database/**
- tests/security/tenant-isolation/**

## Forbidden files

- lib/**
- features/**
- app/**

## Invariants

- `organizations`: `id uuid primary key`, `name` with a length check, `slug`
  unique and format-constrained, `created_at`, `updated_at`.
- `memberships`: `organization_id` and `user_id` both `not null` with foreign
  keys, `role` constrained to `owner | admin | member | viewer`, and a unique
  constraint on `(organization_id, user_id)` so a user cannot hold two roles in
  one organization.
- A partial unique index guarantees at least one `owner` per organization
  cannot be silently removed — or, if that is not expressible, a trigger
  enforces it and the handoff says which was used and why.
- RLS is enabled on both tables in the same migration that creates them.
- Policies resolve access through `memberships`, never through a claim carried
  in the JWT that the client could influence.
- Indexes cover the queries that will actually run: memberships by `user_id`,
  memberships by `organization_id`.
- Soft deletion is anticipated (`README.md` §33): include `deleted_at` rather
  than requiring a later migration across live tenant data.

## Acceptance criteria

- `supabase db reset` applies the migration cleanly from empty.
- The migration is deterministic: applying it twice from empty produces an
  identical schema.
- All five §8 isolation checks fail for a non-member, proven at the RLS layer
  with no application code in the path.
- A user cannot insert a membership granting themselves access to another
  organization.
- Typecheck, lint, format, and tests pass.

## Required tests

- security: user A cannot read, update, or enumerate organization B
- security: user A cannot insert a membership into organization B
- security: a viewer cannot write to organization tables
- integration: the unique membership constraint rejects a duplicate pair
- integration: the last owner cannot be removed or demoted
