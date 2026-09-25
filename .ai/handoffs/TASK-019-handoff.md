## Handoff

### Summary

Phase 6 begins. `public.public_disclosure(p_public_id text)` is the one
thing an unauthenticated caller may do: it turns a public deployment
identifier into the notice that deployment should show, and returns nothing
else.

```sql
select version, language, message from public.public_disclosure('dep_…');
```

Granted to `anon`, `authenticated` and `service_role`. It returns one row
when the deployment is active, its AI system is active, the organization is
not soft-deleted, and the system's current version is enabled — and no row
in every other case, without saying which.

This pull request is the migration and its tests only. Nothing in the
application reads the function yet; the route is TASK-019a, in the pull
request after this one, because a migration adding a function the
application reads ships before the code that reads it.

### Decisions

Owner, 2026-09-25:

1. **A `security definer` function granted to `anon`**, not the
   service-role client in the route. The anon key can do exactly one thing
   on this surface and see exactly three columns, and the rules about which
   deployments resolve live in SQL. No service-role client touches the one
   endpoint the whole internet can call, where a query-construction mistake
   would be a cross-tenant leak rather than an empty result. Cost: a
   migration, so TASK-019 is two pull requests.
2. **`learnMoreUrl` is not returned.** README §11 documents it, but nothing
   stores it and no screen can set it, so it would be an always-null key and
   a dead branch in the widget. TASK-019a corrects README §11; a later task
   adds the column, the editor field and the widget's link together.
3. **One identical answer for every reason there is nothing to show** —
   unknown identifier, archived deployment, archived system, deleted
   organization, never published, current version turned off. The endpoint
   must not be an oracle for which deployments exist.
4. **The response may be cached publicly for about 60 seconds** (TASK-019a's
   concern; it is why this function is `stable` and takes no session).

Implementer (proposed, awaiting sign-off): a set-returning function so
"nothing" is an empty array; `security definer`, `stable`, empty
`search_path`; revoked from `public` before granting; every condition in the
`where` clause; the current version found through TASK-016's version key;
the identifier matched exactly; a restore reads the status rather than
assuming a new identifier; nothing written and nothing audited; no rate
limiting here; the pgTAP tests own the rules. The contract states each
one's reason and what was rejected.

### Files changed

- `.ai/tasks/TASK-019-public-disclosure-lookup.md` (new): the contract
- `supabase/migrations/20260925120000_public_disclosure_lookup.sql` (new):
  the function and its grants
- `supabase/tests/public_disclosure.test.sql` (new): 16 pgTAP assertions
- `tests/integration/database/public-disclosure.supabase.ts` (new): the
  same function through PostgREST with the anon key, as the widget will
  reach it

### Security considerations

- **This is the first grant to `anon` anywhere in the schema.** Before this
  migration `anon` could execute nothing and select nothing; after it,
  `anon` can execute this one function and still select nothing. Four pgTAP
  assertions and one integration test hold that line.
- **The function bypasses RLS, which is the point, so its `where` clause is
  the whole boundary.** It is narrower than any policy could be: one
  deployment by unique identifier, three columns, four status conditions.
  Every condition is asserted by its own pgTAP test, so a later change to a
  status or a policy cannot quietly widen it.
- **Six failure causes, one answer.** An identifier that names nothing, an
  archived deployment, an archived system, a soft-deleted organization, a
  system that never published, and a turned-off current version all return
  an empty result. A caller learns nothing about which deployments exist or
  what state a customer's account is in.
- **A turned-off notice is not replaced by an older one.** `enabled` is
  required of the current version, not of "the newest enabled version" — a
  pgTAP test publishes an enabled version, turns it off above, and asserts
  nothing resolves.
- **No identifier leaves the database.** Three columns: `version`,
  `language`, `message`. No row id, organization, system, hostname,
  timestamp or author. A pgTAP assertion reads the function's own signature,
  so adding a column to the return type fails the test.
- **It never writes.** `stable`, no statement writes, nothing is audited. A
  function that wrote on every page view of every customer site would be a
  denial-of-service surface with a row per request.
- **The rate limiter stays the service role's.** `consume_rate_limit` is
  not granted to `anon`, and an integration test calls it as a visitor and
  asserts the refusal. Rate limiting is the route's, in TASK-019a.
- **A restored deployment resolves again, under the same identifier.**
  `public_id` is fixed for a deployment's life; the function reads the
  status at call time rather than treating an archived identifier as dead
  forever. A pgTAP test archives, restores and asserts it resolves.

### Tests

Required by the contract: all covered. 16 pgTAP assertions and 5 integration
tests.

One fault was found while running them, in the fixture rather than in the
function: the AI system named "System Archived" was never actually archived,
so the case passed a row through. Archiving it — after publishing its notice,
because nothing is published under an archived system — made the test fail
for the right reason and then pass. Worth noting that archiving a system does
not archive its deployments (TASK-011), so an active deployment under an
archived system is a real state, and it is the one this case tests.

### Commands run

On the final state of the branch:

```
pnpm typecheck                       pass
pnpm lint                            pass
pnpm format:check                    pass
pnpm test                            59 files, 1649 tests, pass
supabase test db --local             8 files, 289 tests, pass
vitest --config vitest.supabase.*    31 files, 394 tests, pass
pnpm test:e2e:supabase               12 tests, pass
next build                           pass
```

The database was reset to the migration head before the database suites and
again before the browser suite. `CODEX-SECURITY.md`'s sha256 was checked
before and after `pnpm format`: unchanged.

### Before merging

- **This pull request has a migration.** Supabase's "Deploy to production"
  applies it on merge. It adds one function and grants execute on it to
  `anon`, `authenticated` and `service_role`. It alters no table, no policy
  and no existing function, so nothing that exists today changes behaviour;
  until TASK-019a merges, nothing calls it.

### Remaining concerns

- **TASK-019a is owed**: the route, its rate limiting, its CORS policy, its
  60-second cache, and the README §11 correction that drops `learnMoreUrl`
  from the documented response.
- **`learnMoreUrl` is owed** as a whole: a column, an editor field and the
  widget's link, in one later task.
- **The plan still lists a single TASK-019.** Splitting it in two follows
  directly from decision 1; `.ai/PLAN.md` is outside this task's Allowed
  files, so Phase 6's task list is left for the owner to confirm.
- **Rate limiting is not owed after all.** The plan says it "lands here";
  it landed in Phase 1 (TASK-003c). TASK-019a reuses `consumeRateLimit`
  with new entries in `RATE_LIMITS`, as the plan's own "not a new
  implementation" asks.
- **Owed from earlier tasks, unchanged:** stale-save protection on the AI
  system edit form; a member directory if a publisher is ever to be named.
