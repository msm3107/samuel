## Handoff

### Summary

A signed-in user can create an organization, from the dashboard or with
`POST /api/organizations`, and becomes its owner. One database function
writes the organization, the owner membership and both audit events in one
transaction. The tenant boundary is now tested through the API routes as
well as through RLS.

### Decisions

1. **One `security definer` function, called with the user's own session.**
   `public.create_organization(p_name)` takes the owner from `auth.uid()`,
   the subject of the JWT Supabase Auth signed.
   - Rejected: calling it with the service role and passing
     `session.userId`. It would work, but the service-role rule says the
     key never serves a request the session client can serve, and here the
     session client can. A user ID parameter is also one more place an
     identity could be substituted.
   - Upside: the function has no owner parameter at all. A direct Data API
     call naming another user fails with "function not found" (tested).
   - Downside: it is callable through the Data API as well as the route, so
     the route's checks are not the only door. Hence decision 4, and the
     name rules repeated in the function.
2. **Audit rows are written inside the function**, as the owner decided on
   the TASK-006 review. The event that establishes ownership cannot go
   missing, and the route never builds an `OrganizationAccess` for someone
   who is not a member yet. The rows skip the recorder's Zod check, so a
   test reads them back through `AUDIT_EVENTS`' schemas.
3. **The slug is the server's, never reported as taken** (owner, 2026-09-21).
   - From the name: lowercased, accents dropped (NFKD, then combining marks
     removed), `ł ß æ œ ø þ đ ħ ı` mapped by hand, other characters become
     hyphens, and the result is cut to 50 characters. "Zażółć Gęślą Jaźń"
     becomes `zazolc-gesla-jazn`.
   - A taken, reserved or too-short base gets a six-hex-character suffix.
   - `insert … on conflict (slug) do nothing` and a retry decide
     uniqueness, never a read beforehand. A concurrent insert of the same
     slug waits for the other transaction, then takes a suffix.
   - Rejected: a user-chosen slug with a 409 "taken". It reveals which
     slugs, and so probably which companies, are customers (README §8).
   - Downside: some slugs have a random tail, and there is no way to change
     a slug yet.
4. **At most 10 organizations per user per hour, enforced in the function**
   (owner, 2026-09-21).
   - It counts organizations the user owns that were created in the last
     hour. A per-user `pg_advisory_xact_lock` serializes one user's
     creations, so twelve concurrent calls create exactly ten (tested, and
     removing the lock fails that test). Other users are not held up.
   - The refusal is `SQLSTATE PT429`, which PostgREST answers as HTTP 429.
     The route maps it to 429 `organization_limit_reached`.
   - Rejected: a limit in `lib/security/rate-limit.ts`. It only covers the
     route, not a direct Data API call, and `lib/security` is forbidden
     here anyway.
   - Downside: an organization that is hard-deleted stops counting.
5. **Reserved slugs are a constant array in the function** (owner,
   2026-09-21). A unit test reads it from the migration and asserts every
   top-level route under `app/` is on it. Adding a route folder without
   reserving it fails `pnpm test`.
6. **Shared API plumbing in `lib/http/api.ts`** (out of contract, recorded as
   an amendment):
   - One error format for every route: `{ error: { code, reference } }`.
     The reference is `err_` plus 12 hex characters, the same as the proxy's.
   - One mapping from thrown errors to statuses:
     - `AuthenticationError`: 401
     - `AuthorizationError`: 403, one code for missing, deleted, foreign
       and malformed IDs alike
     - a session or membership lookup failure: 503
     - anything else: 500, logged with the error name and SQLSTATE only
   - **Cross-site requests:** `Origin` must equal the configured app origin,
     and a missing `Origin` is refused. This is checked before the session,
     so a forged request costs no auth call.
     - Why this is needed: route handlers, unlike server actions, get no
       CSRF check from Next.js. `SameSite=Lax` still lets a sibling
       subdomain send the cookie.
   - **Bodies:** only `application/json`, which a cross-site HTML form
     cannot send. At most 4 KB, counted while the body is read, not taken
     from `Content-Length`.
   - Rejected: keeping this in `features/organizations/`. Every later route
     needs the same, and two copies would drift.
7. **Bodies are strict.** `{ name }` only. A body that also carries
   `userId`, `role`, `organizationId` or `slug` gets a 400 rather than having
   the extra fields silently dropped, so a client relying on one finds out.
   Names are trimmed; control characters are refused in Zod and in the
   function.
8. **Route order.**
   - POST: origin → `requireSession()` → body → function → serializer.
   - GET and PATCH on `[organizationId]`: `requireOrganizationPermission`
     (session, then membership) runs before the body is read, so a
     non-member learns nothing from validation (tested with an invalid
     body).
   - `readOrganization` and `renameOrganization` take an
     `OrganizationAccess`, not an ID. They also check that its role
     suffices, so a read-level access can't be reused to rename.
9. **Explicit serializer.** `serializeOrganization` validates the row and
   copies `id`, `name` and `slug`. Queries select exactly those columns
   too. A test feeds it extra columns and gets only the three back.
10. **Dashboard.** The page lists the user's organizations and has a create
    form. The form is a server action, which has Next's own Origin check,
    and calls the same `createOrganization`. Errors come back as `?error=`
    codes that map to fixed text, so a crafted link can't put words on the
    page.
11. **Rename is included** (PATCH, owners and admins). The isolation
    requirement "cannot update organization B via the API" needs an update
    route to test. It isn't audited: there is no `organization.updated`
    event type, and adding one means a migration to `audit_events`, which
    this task may not change.

### Files changed

- `supabase/migrations/20260921150000_create_organization.sql` (new): the
  one migration the contract allows
- `supabase/tests/create_organization.test.sql` (new): pgTAP, 25 tests
- `features/organizations/organization.ts` (new): the name schema and the
  serializer
- `features/organizations/create-organization.ts` (new)
- `features/organizations/organization-queries.ts` (new): list, read,
  rename
- `app/api/organizations/route.ts` (new): GET and POST
- `app/api/organizations/[organizationId]/route.ts` (new): GET and PATCH
- `app/(dashboard)/dashboard/page.tsx`: the list and the form
- `app/(dashboard)/dashboard/actions.ts` and `messages.ts` (new)
- `lib/http/api.ts` (new): amendment
- `package.json`: `--passWithNoTests` removed from `test:security`
- `app/api/.gitkeep`: removed
- Tests:
  - `tests/integration/organizations/create-organization.supabase.ts`
    (new): 7 tests
  - `tests/security/tenant-isolation/organizations-api.supabase.ts` (new):
    18 tests
  - `tests/security/tenant-isolation/organizations-api.test.ts` (new): 25
    tests, fake client
  - `tests/unit/organizations/organization.test.ts` (new): 26 tests
  - `tests/security/tenant-isolation/support/acting-user.ts` (new): routes
    the session layer to a real signed-in client. It uses
    `AsyncLocalStorage`, so concurrent requests keep their own users.
  - `tests/security/tenant-isolation/support/api-requests.ts` (new)
  - `tests/security/tenant-isolation/support/tenants.ts`: cleanup also
    deletes organizations the test users created through the app
  - `tests/security/tenant-isolation/organizations.supabase.ts`: header
    comment updated
  - `tests/integration/auth/authenticated-dashboard.test.ts` and
    `tests/security/auth/unauthenticated-dashboard.test.ts`: the page's new
    props, and a fixed organization list in place of the database. No
    assertion was removed, and one was added (the list renders).
- `.ai/tasks/TASK-007-organization-creation.md`: the owner's answers and the
  out-of-contract files

### Security considerations

- The owner is the JWT's subject. No request field, route parameter or
  function parameter can name another user.
- The creation is all or nothing. A failure after the organization insert
  (a foreign-key failure through the route, or an audit-insert failure in
  pgTAP) leaves no organization.
- The service role is not used anywhere in this task's request paths.
- Cross-tenant read, update and enumeration are refused through the routes
  with one 403 code, indistinguishable from a nonexistent or deleted
  organization.
- No error body carries a message, SQL, hostname or SQLSTATE (tested with a
  leaky database error).

### Tests

- Required by the contract:
  - Creation succeeds and yields an owner membership: integration, plus
    pgTAP.
  - Concurrent slug collision resolves deterministically: six concurrent
    requests from three users for the same name all succeed. Exactly one
    gets the plain slug, none shares one, and each organization is owned by
    the user who asked.
  - A failure after the organization insert leaves no ownerless row:
    - integration: a user whose account was deleted but whose JWT is still
      valid, so the membership insert fails its foreign key;
    - pgTAP: a failing audit insert.
  - User A cannot read, update or enumerate organization B via the API.
  - User A cannot generate reports or act for B. There is no reports
    feature yet, so this runs through
    `requireOrganizationPermission("reports.generate")` against the real
    database, and "act for" through the rename route.
  - An unauthenticated creation fails: 401, nothing created.
- Mutation checks, each reverted:
  - removing the Origin check fails 4 tests;
  - reading the body before the session fails 1;
  - a serializer passing the whole row fails 1;
  - a non-strict body schema fails 5 (real DB);
  - removing the advisory lock fails the concurrent-cap test (real DB);
  - removing `on conflict … do nothing` fails 2 slug tests (real DB).

### Commands run

See the PR. Each gate was run with the owner's untracked
`CODEX-SECURITY.md` set aside and restored, and its hash verified.

### Remaining concerns

- **The dashboard form was not exercised in a browser.** The page render is
  tested, and the server action calls the same tested function. A
  Playwright flow needs a signed-in session through Mailpit, which fits
  better with the E2E work.
- **Renames aren't audited.** That needs a new event type, so a migration
  on `audit_events`. Proposed for the member-management task, which touches
  audit types anyway.
- **Slugs can't be changed** after creation, and some carry a random tail.
- **The per-request client is still created twice** (session, then query).
  This is the same TASK-005b note.
- **Report generation has no route yet.** When it does, its suite must
  repeat the cross-tenant check at the HTTP layer.
