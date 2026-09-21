## Handoff

### Summary

One place that answers "may the signed-in user do this in this
organization": `requireOrganizationRole`, a permission table on top of it,
and `requireMemberManagement` for the "admins manage members except owners"
rule. Every refusal is the same `AuthorizationError`.

### Decisions

1. **Where the membership is read.** The signed-in user's own Supabase
   client, filtered by the organization and the session's user ID.
   - Rejected: the service-role client. Rejected: an RPC to
     `authz.has_org_role`.
   - Why: the RLS policies already let a user see their own membership, and
     let owners and admins see their team's. The service-role client must
     not serve what the session client can. `authz` is not exposed by the
     Data API, so it cannot be called over RPC.
   - Upside: RLS stays in the path, so a deleted organization's memberships
     are hidden by the policy, with no second check in TypeScript.
   - Downside: one extra database round trip per check. It is not memoized,
     on purpose (see 4).
2. **The resolving session client, and its held cookie removals are never
   applied.**
   - Rejected: `createSessionClient`, which writes every cookie removal.
   - Why: if auth-js refreshed and failed here, a membership read would sign
     the person out. `requireSession()` has already decided whether the
     session is good, and only it may end the session.
3. **One error for every refusal.** Every refusal throws the same
   `AuthorizationError`, with code `organization_access_denied`, no cause
   and no detail. That covers a non-member, a role too low, an organization
   that doesn't exist or was deleted, a malformed ID, and an admin acting on
   an owner. The reason goes to the server log only.
   - Rejected: separate "not found" and "forbidden" errors.
   - Why: separate errors would tell anyone which organization IDs exist.
   - Downside: debugging needs the log. The log carries `reason`, and the
     raw ID when it failed validation is never logged.
4. **No caching.** The membership is read on every call. `requireSession()`
   stays memoized per render, but that caches who the user is, not what
   they may do.
   - Upside: a revoked membership is refused on the very next call.
   - Downside: a page making several checks makes several reads. If this
     ever shows up in profiles, the fix is a per-request memo, never a
     cross-request one.
5. **A database failure is a separate error**, `MembershipLookupError`.
   - Rejected: turning it into a refusal.
   - Why: an outage should surface as an error with a reference code, not
     as "you have no access", which sends people to the wrong fix.
   - Both fail closed. A row with a role the code doesn't know is treated
     the same way.
6. **A permission table as well as the role hierarchy.**
   `ORGANIZATION_PERMISSIONS` maps README §10's abilities to a minimum role.
   `requireOrganizationPermission` reads it.
   - Rejected: role checks written at every call site.
   - Upside: "billing requires owner" lives in one place and is tested as
     data.
   - Downside: there are two entry points, the role check and the permission
     check. Both go through the same function.
7. **`requireMemberManagement` is a separate function.** Admins may not act
   on an owner or make anyone an owner, and no single minimum role can say
   that. The function reads the target's role from the database, never from
   the caller.
   - This mirrors the `memberships_update_manager` policy, so the app
     refuses the request before RLS silently changes 0 rows.
   - Downside: the function is duplicated at the policy layer, by design:
     RLS is defense in depth (README §8).
8. **An unknown role or permission name throws** (review of PR #19,
   blocking). Before the fix, a name outside the hierarchy ranked at -1,
   below every real role, and an unknown permission looked up nothing. So a
   misspelt minimum such as `"Owner"`, `"billing:manage"` or `"constructor"`
   admitted every member, viewers included. The types stop this, but a cast
   or a configuration value does not.
   - `roleSatisfies` now throws `UnknownRoleError` for either argument.
   - `minimumRoleFor` checks the permission with `Object.hasOwn`, so
     inherited names don't count, and throws `UnknownPermissionError`.
   - The helpers check the names before they touch the session or the
     database.
   - Rejected: returning `false`. That would be safe, but it would pass for
     an ordinary refusal and hide the bug. An unknown name is the caller's
     mistake, so it surfaces as a server error with a reference code.
   - `requireOrganizationPermission` is now `async`, so this failure, like
     every other, arrives as a rejection.
   - Downside: a route with a typo returns a 500 instead of a 403, until
     someone fixes it.
9. **Two more permissions**, from the review: `organization.update` and
   `members.read`, both at `admin`. They match what the database already
   allows owners and admins. TASK-006 and TASK-007 will need them, and
   without table entries they would write `minimumRole: "admin"` inline.
10. **`import "server-only"`** keeps the helper out of any client bundle.
    Tests mock it, as the existing proxy tests do.

### Files changed

- `lib/auth/organization-roles.ts` (new): the hierarchy, `roleSatisfies`,
  and the permission table
- `lib/auth/require-organization-role.ts` (new)
- `lib/auth/errors.ts`: `AuthorizationError`, `MembershipLookupError`
- `tests/unit/auth/organization-roles.test.ts` (new): 46 tests
- `tests/security/auth/organization-role.test.ts` (new): 61 tests, fake
  database client
- `tests/security/auth/organization-role.supabase.ts` (new): 15 tests, real
  local database and RLS
- `vitest.supabase.config.ts`: includes `tests/security/auth/**/*.supabase.ts`.
  This is outside the allowed files, and was approved by the owner in chat.
  See the contract's amendment.
- `.ai/tasks/TASK-005-authorization-core.md`: that amendment

### Security considerations

- None of the helpers takes a user ID or a role. The user comes from
  `requireSession()`, and roles come from the database. A test passes an
  extra `userId` and `role: "owner"` by cast, and they are ignored.
- Organization and target IDs are validated as UUIDs with Zod, and are
  refused before any query when invalid.
- There is no service-role use, and no RLS, grant or migration change.

### Tests

- The unit suite covers all 16 role and minimum-role pairs, including the
  equality cases, written out as literals. It also checks the permission
  table against README §10 exactly.
- The security suites cover:
  - a non-member is refused;
  - a viewer is refused for every write-level minimum;
  - an admin is refused when acting on an owner, or when assigning owner;
  - a revoked membership is refused on the next call;
  - a soft-deleted organization is refused;
  - every kind of refusal gives an identical error;
  - an unknown role or permission name, such as `"Owner"`,
    `"billing:manage"` or `"constructor"`, throws before any query.
- Mutation checks, each reverted:
  - skipping the "target is owner" check fails both suites (2 fake-client
    tests, 1 real-database test);
  - dropping the `user_id` filter fails 22 fake-client and 6 real-database
    tests;
  - ignoring the minimum role fails 20 tests;
  - skipping the "assigns owner" check fails 1 test;
  - letting unknown role names through `roleSatisfies` again fails 10
    tests;
  - replacing `Object.hasOwn` with the `in` operator fails 7 tests.

### Commands run

See the PR. Each gate was run with the owner's untracked
`CODEX-SECURITY.md` set aside and restored, and its hash verified.

### Notes for the next tasks

- **Leaving an organization does not go through `requireMemberManagement`.**
  That helper requires admin, but the database lets any member delete their
  own membership. A TASK-007 "leave" action must check only
  `requireOrganizationRole({ minimumRole: "viewer" })` and delete the
  caller's own row. Using the management helper would mean members could
  never leave.
- **Running the real-database suites locally several times in a row fails
  the sign-in tests.** Locally every request shares one network bucket, so
  about 7 runs within 5 minutes use up the app's `callbackGlobal` cap (40
  callbacks per 5 minutes). Those tests then get `sign_in_unavailable`.
  Wait 5 minutes and run again. CI runs once, so it is not affected.
  - Rejected for now: raising the cap for the test setup. Then local would
    differ from production for exactly the limit these tests exercise.
  - A line in the testing docs is worth adding when those docs are next
    touched. They are outside this task's files.

### Remaining concerns

- Nothing calls the helpers yet. TASK-006 and TASK-007 are the first
  callers.
- **The membership read builds its own client from the cookies.** It
  doesn't reuse the one `requireSession()` just used (review note 1). That
  has two consequences:
  - On a page, an access token that expires between the proxy and the
    render could be refreshed twice with the auth server. The second
    refresh isn't counted by the proxy's limit.
  - The read uses a token that isn't the exact one `requireSession()` just
    verified.
  - Likelihood: low. The proxy refreshes before each render, so this needs
    the token to expire in a window of milliseconds.
  - Proposed fix, as a follow-up task (TASK-005b): create the resolving
    client once per request with React `cache()`, and have
    `requireSession()` and this helper share it.
  - Why it isn't in this PR: it changes `requireSession()`, the most
    sensitive code in the project, together with the cookie-removal logic
    of TASK-003i. That deserves its own review, not a tag-along change.
