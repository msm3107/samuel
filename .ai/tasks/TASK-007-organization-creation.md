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

Decided by Mikołaj Smoliniec (project owner), 2026-09-21, on the TASK-006
review's recommendation: the function writes the `organization.created` and
`member.added` audit rows in the same transaction. An audit failure inside
one database function is a real database fault, and the event that
establishes ownership can never go missing. The route therefore never
builds an `OrganizationAccess` for a user who is not a member yet.

- Allowed: one new file in `supabase/migrations/`, for the
  create-organization function.
- Still forbidden: changing any existing migration, table, policy or grant.

## Amendment: the open questions, answered

Decided by Mikołaj Smoliniec (project owner), 2026-09-21:

- **Slugs:** the server derives the slug from the name and never reports a
  collision. A taken or reserved slug gets a random six-character suffix in
  the same transaction. The acceptance line on concurrent requests is
  amended below to match: there is no "slug taken" error to be
  deterministic about.
- **Reserved slugs:** a list in the create function. A test keeps it in step
  with `app/`'s top-level routes.
- **Abuse cap:** a user creates at most 10 organizations an hour, enforced in
  the function, because it is callable through the Data API as well as the
  route. Past it the route answers 429.

On the PR #21 review, same date:

- **The slug suffix shows a slug was taken.** Accepted: slugs are public.
- **The cap counts `organization.created` audit rows**, not current
  ownership, so an ownership transfer cannot reset it. This needs one
  partial index on `audit_events`, added in this task's migration. It is the
  one change to an existing table this task makes, an exception to "still
  forbidden" above.

## Amendment: files outside the list

Allowed under the owner's standing permission (2026-09-21), recorded here:

- `lib/http/api.ts` (new): the JSON API error format, the same-origin
  check and bounded body reading. Every later API route needs the same, so
  it is not organization code.
- `tests/unit/organizations/**` (new): name, serializer, form messages, and
  the reserved-slug drift test.
- `supabase/tests/create_organization.test.sql` (new): pgTAP.
- `package.json`: `--passWithNoTests` removed from `test:security`, as this
  task requires.
- `app/api/.gitkeep`: removed, the folder now has routes.
- `tests/integration/auth/authenticated-dashboard.test.ts` and
  `tests/security/auth/unauthenticated-dashboard.test.ts`: the dashboard page
  now takes `searchParams` and lists organizations. The authenticated test
  gets a fixed list in place of the database; no assertion was removed.
- `tests/e2e/auth/support/stub-auth-server.mjs`: answers the dashboard's
  organization query with an empty list, for the stub session only.
- `tests/e2e/auth/sign-in.supabase.spec.ts`: one new test that creates an
  organization through the dashboard form against real Supabase.

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
  deterministic error, not two rows or a 500. _Amended above: concurrent
  requests for the same name each produce an organization, exactly one with
  the plain slug and no two sharing one; never a 500._
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
