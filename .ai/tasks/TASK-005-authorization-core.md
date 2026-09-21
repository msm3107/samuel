# TASK-005 — Authorization core

## Objective

One helper that answers "may this user do this in this organization", so no
feature ever writes that logic inline.

## Owner agent

Backend

## Dependencies

TASK-002, TASK-004.

## Allowed files

- lib/auth/**
- tests/unit/auth/**
- tests/security/auth/**

## Amendment: the real-database test runner

`tests/security/auth/` is matched only by `vitest.config.ts`, which runs
without a database, so a suite there cannot show the helper's membership read
working under the real RLS policies. Adding `tests/security/auth/**/*.supabase.ts`
to `vitest.supabase.config.ts` runs that suite in CI's existing real-Supabase
job. Approved by Mikołaj Smoliniec (project owner), 2026-09-21, over testing
with a fake database client only.

## Forbidden files

- supabase/migrations/**
- features/**
- app/**

## Invariants

- The role hierarchy `owner > admin > member > viewer` is defined once, as
  data, and compared in one function.
- `requireOrganizationRole()` takes the organization from the authenticated
  route context and resolves membership from the database on every call. It
  never trusts a role, membership, or organization ID supplied by the caller's
  request.
- It throws a typed `AuthorizationError`. It does not return a boolean that a
  caller can forget to branch on.
- A non-member and an insufficiently privileged member produce the same
  outcome to the client, so the helper cannot be used to enumerate which
  organizations exist.
- No caching of membership across requests. A revoked membership takes effect
  immediately, not at the end of a TTL.
- The helper is not a rate limit, and a rate limit is not this helper (§61).

## Acceptance criteria

- Each role's permissions match `README.md` §10 exactly, including that
  `admin` may manage members but not an `owner`.
- Billing and ownership transfer require `owner`.
- A non-member receives the same response as an under-privileged member.
- Typecheck, lint, format, and tests pass.

## Required tests

- unit: every role/minimum-role pair, as a table, including equality cases
- security: a non-member is rejected
- security: a viewer is rejected for every write-level minimum
- security: an admin is rejected when acting on an owner
- security: a revoked membership is rejected on the very next call
