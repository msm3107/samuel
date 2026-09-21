## Handoff

### Summary

Organizations and memberships, with RLS, as one migration: the tenant boundary
every later table resolves through. Access is decided only from `memberships`
and `auth.uid()`. There is no JWT claim, no client-supplied user ID, and no
application code in the path.

### Decisions, and what they cost

1. **Last owner: a trigger, not a partial unique index.** A partial unique
   index on `(organization_id) where role = 'owner'` can say "at most one
   owner", not "at least one", so the contract's fallback applies.
   `private.ensure_organization_keeps_an_owner()` runs after every update or
   delete on `memberships`, for every role including the service role.
   - Upside: nothing, whether a buggy route, a script or the dashboard, can
     leave an organization ownerless.
   - Downside: deleting a user who is the last owner of a live organization is
     refused too. Phase 13's account deletion has to transfer ownership or
     delete the organization first. The one exemption is deleting the
     organization row itself, which cascades to its memberships.
2. **The trigger locks the organization row** (`select … for update`).
   Without the lock, two owners demoting each other at the same moment both
   see the other still an owner, and the organization ends up with none. A
   mutation run proved this: with the lock removed, the race test failed 1
   run in 3.
   - Upside: the invariant holds under concurrency.
   - Downside: owner changes within one organization are serialized. That is
     negligible at this write rate.
3. **Policy helpers live in a new `authz` schema,** not in `public` or
   `private`. Policies on `memberships` must read `memberships`, which needs a
   `security definer` function to avoid infinite RLS recursion.
   - Why not `public`: it is exposed through the Data API, so the function
     would become a callable RPC, and the Supabase linter flags definer
     functions there.
   - Why not `private`: the rate-limit migration deliberately gives the
     signed-in role no access to it at all, and this function needs
     `authenticated` to have `usage`. Loosening `private` would weaken an
     earlier decision.
   - `authz.has_org_role(org, roles[])` answers only for `auth.uid()`; the
     caller cannot name another user.
   - Downside: one more schema to know about.
4. **Least-privilege grants, not Supabase's defaults.** Supabase grants
   `anon` and `authenticated` everything on new `public` tables. This
   migration revokes that and grants back only what is used:
   - `select` on both tables;
   - `update (name)` on organizations;
   - `update (role)` and `delete` on memberships;
   - no `insert` on either table, and nothing for `anon`.

   Column grants make `organization_id`, `user_id`, `slug` and `deleted_at`
   unwritable by signed-in users, whatever a policy says.
   - Upside: a policy mistake cannot create memberships or move them between
     organizations.
   - Downside: TASK-007 (organization creation) and a future invitations task
     need their own `security definer` functions, or grants added
     deliberately.

5. **Roles follow README §10.**
   - Owners change or remove anyone.
   - Admins manage everyone except owners: they cannot touch an owner's row
     or make anyone an owner.
   - Anyone may leave, and the trigger still protects the last owner.
   - Members and viewers see only their own membership row. Owners and admins
     see the whole team.
   - Showing the team list to every member was rejected as less private than
     needed today. Relaxing it later is one policy change.
6. **Slugs are unique across soft-deleted organizations.** A released slug can
   never be claimed by someone else to impersonate the old tenant's public
   pages. Downside: a deleted organization's slug is gone for good unless it
   is renamed first.
7. **Soft deletion.** `deleted_at` exists (README §33), and `has_org_role`
   treats a soft-deleted organization as granting no access. Nothing sets
   `deleted_at` yet; that is a later task's job.
8. **Indexes.**
   - `memberships_user_id_idx` serves "my organizations".
   - Memberships by organization reuse the unique `(organization_id, user_id)`
     index, whose leading column is `organization_id`. A second index would
     only slow writes.
9. **Seed data:** none added. Memberships need `auth.users` rows, and seeding
   those in SQL couples the seed to GoTrue's internal schema. The suites build
   their own fixtures.

### Files changed

- `supabase/migrations/20260921120000_organizations_and_memberships.sql` (new)
- `tests/security/tenant-isolation/organizations.supabase.ts` (new, 19 tests)
- `tests/security/tenant-isolation/support/tenants.ts` (new, fixtures)
- `tests/integration/database/memberships.supabase.ts` (new, 14 tests)
- `vitest.supabase.config.ts`: includes the two folders above, as approved
  by the owner (see the contract's amendment)
- `.ai/tasks/TASK-004-organizations-schema.md`: that amendment

### Security considerations

- Identity is `auth.uid()` only, the subject of the JWT that GoTrue signed.
  Policies never read `app_metadata` or any other claim.
- RLS is enabled in the same migration, before any grant.
- All functions set `search_path = ''` and have `execute` revoked from
  `public`. Only `authz.has_org_role` is granted, and only to `authenticated`.

### Tests

README §8 at the RLS layer, as user A against organization B:

- A cannot read B, whether by id, by listing, or through B's memberships.
- A cannot update B; the update affects 0 rows and B is re-read unchanged.
- A cannot enumerate B through listing or filtering.
- A cannot delete B's memberships.
- A cannot insert a membership into B, even as owner (42501), and cannot
  insert an organization.

"Generate reports" and "API routes" don't exist yet. At this layer they reduce
to the read check, and their own tasks must test them over HTTP.

Other tests:

- **Viewer:** cannot rename the organization, change any role (including their
  own to owner), or delete another membership.
- **Admin:** cannot demote, remove or create an owner, but can demote a member
  to viewer.
- **Member:** sees only their own membership.
- **Anonymous client:** gets 42501 on both tables.
- **Columns:** `organization_id` and `user_id` cannot be changed (42501).
- **Soft deletion:** a soft-deleted organization is invisible to its owner.
- **Constraints:**
  - a duplicate `(organization_id, user_id)` is rejected (23505);
  - an unknown role is rejected (23514);
  - bad slugs (`Bad Slug`, `-x-`, `ab`) and bad names (empty, 121
    characters, padded) are rejected (23514).
- **Last owner:**
  - cannot be removed, whether from their own client or the service role;
  - cannot be demoted;
  - with two owners, one can go, then the other cannot;
  - concurrent mutual demotion leaves exactly one owner.
- **Cascade and timestamps:** deleting an organization removes its
  memberships, and `updated_at` ignores the value the client sends.

The subagent's tests were tightened in review:

- bare "error is not null" checks now assert the exact code (42501);
- a missing cross-tenant delete test was added;
- cleanup moved to `afterAll`, so a failing assertion cannot leak fixtures.

### Commands run

- `supabase db reset`: applied both migrations from empty.
- Determinism: dumped `public`, `authz` and `private` after a reset, reset
  again and dumped again. The two dumps are identical (385 lines, empty diff).
  The dump's grants match decision 4.
- Mutation check: removing `for update` from the trigger made the race test
  fail in 1 of 3 runs. The migration was restored and the database reset.
- `pnpm test:supabase`: 49 passed, run 3 times in a row. This covers 5 files,
  including the existing auth and rate-limit suites.
- `pnpm typecheck`, `pnpm lint` and `pnpm format:check`: passed, with the
  owner's untracked `CODEX-SECURITY.md` set aside and restored (hash
  verified).
- `pnpm test`: 632 passed.
- `pnpm build`: fails in a shell with no environment at all, on env
  validation, before anything this task touches. It passed when run as
  `node scripts/local-env.mjs --exec node node_modules/next/dist/bin/next build`.

### Remaining concerns

- The race test detected a missing lock only probabilistically (1 in 3 runs
  here). TASK-004a repeats it 20 times, which leaves about a 0.03% chance of
  a regression passing one run. Deterministic proof would need two held-open
  transactions, which PostgREST cannot express. Accepted by Mikołaj Smoliniec (project owner), 2026-09-21.
- Deleting a user who is the last owner of a live organization is refused.
  Phase 13's account deletion must handle this (decision 1). Accepted by Mikołaj Smoliniec (project owner), 2026-09-21.
- TASK-007 needs a `security definer` function, or a deliberate grant, to
  create an organization together with its owner membership. There is
  intentionally no insert path today. Accepted by Mikołaj Smoliniec (project owner), 2026-09-21.
