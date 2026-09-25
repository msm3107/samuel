# TASK-019 — Public disclosure lookup (database)

## Objective

Give an unauthenticated caller one way, and only one way, to turn a public
deployment identifier into the notice that deployment should show. A
`security definer` function in `public`, granted to `anon`, returning the
three fields the widget renders and nothing else.

This is the first half of Phase 6's TASK-019. The route that calls it is
TASK-019a, and ships after this, because a migration adding a function the
application reads goes in before the code that reads it (the rule that
holds from TASK-018 on).

## Owner agent

Database

## Dependencies

TASK-011 (`deployments`, its RLS), TASK-014 (`public_id`, its uniqueness
and `isPublicDeploymentId`), TASK-016 (`disclosures`, `enabled`, the
version key), TASK-017 (publishing). All merged.

## Allowed files

- supabase/migrations/\*\* (one new migration)
- supabase/tests/\*\* (its pgTAP tests)
- tests/integration/database/\*\* (a real-database test of the same rules
  through PostgREST, as the anon key reaches it)

## Forbidden files

- app/\*\*, features/\*\*, lib/\*\*, components/\*\*
- every existing migration: this one adds, it does not rewrite
- supabase/config.toml

## Decisions

Chosen by Mikołaj Smoliniec (project owner), 2026-09-25:

- **A `security definer` function granted to `anon`**, not the service-role
  client in the route. The anon key can then do exactly one thing on this
  surface and see exactly three columns, and the rules about which
  deployments resolve live in SQL where the application cannot forget them.
  No service-role client touches the one endpoint the whole internet can
  call, where a query-construction mistake would be a cross-tenant leak
  rather than an empty result. Cost: a migration, so TASK-019 becomes two
  pull requests. Rejected: the service-role client in the route (one pull
  request, joins readable in TypeScript, but RLS bypassed on the most
  exposed surface in the system).
- **`learnMoreUrl` is not returned.** README §11 documents it, but no
  column stores it and no screen can set it, so it would be an always-null
  key in every response and a dead branch in the widget. A later task adds
  the column, the editor field and the widget's link together. TASK-019a
  corrects README §11. Rejected: adding the column now, null until an
  editor can set it.
- **One identical answer for every reason there is nothing to show**: an
  identifier that names no deployment, an archived deployment, an archived
  AI system, a deleted organization, a system that has never published, and
  a current version that is turned off. The function returns no row in all
  six cases. The endpoint must not be an oracle for which deployments exist
  or what state a customer's account is in. Cost: a customer debugging
  their own installation gets no help from this surface and must use the
  dashboard. Rejected: distinguishing "unknown" from "turned off".
- **The response may be cached publicly for about 60 seconds** (TASK-019a's
  concern; recorded here because it is why the function is `stable` and
  takes no session). A transparency notice that is corrected or withdrawn
  should reach the public within about a minute.

## Proposed by the implementer

All ten accepted on the PR #35 review. Accepted by Mikołaj Smoliniec
(project owner), 2026-09-25.

1. **`public.public_disclosure(p_public_id text)`**, returning
   `table (version integer, language text, message text)`. A set-returning
   function rather than a scalar or a composite: PostgREST gives the caller
   a JSON array of zero or one objects, so "nothing to show" is an empty
   array rather than a null-filled object, and the three columns are named
   by the function's own signature rather than assembled in SQL.
2. **`security definer`, `stable`, `set search_path = ''`.** Definer
   because `anon` holds no membership and every table here is
   membership-scoped by RLS; stable because it only reads, which lets
   Postgres and PostgREST treat it as a read; an empty `search_path` with
   every name written in full, as every other function in this schema does,
   so no object can be resolved through a caller-controlled path.
3. **Revoked from `public`, then granted to three roles.** A function is
   executable by `public` by default and a later grant does not take that
   away, so the revoke comes first. Then `anon`, `authenticated` and
   `service_role`: `authenticated` as well as `anon`, so a signed-in
   visitor to a customer's site is served the same as anyone else, rather
   than failing because their browser happens to hold a session for this
   application.
4. **Every condition is in the `where` clause, not in the application.**
   The deployment is active, its AI system is active, the organization is
   not soft-deleted, and the version returned is the system's highest and
   is `enabled`. A row comes back only when all of them hold.
5. **The current version is the highest version, found through
   `disclosures_ai_system_id_version_key`.** That is the index TASK-016
   made for exactly this, so no new index is needed. `enabled` is required
   of that row, not of "the newest enabled row": a notice turned off is
   turned off, not replaced by an older one that was on.
6. **The identifier is matched exactly**, on `deployments.public_id`, which
   is unique. No trimming, no case folding, no pattern check: a value of
   the wrong shape simply matches nothing, and the route refuses it before
   this is called anyway (TASK-019a). One spelling per deployment.
7. **A restore is not assumed to issue a new identifier.** `public_id` is
   fixed for a deployment's life; archiving and restoring the same row
   gives back the same identifier, and only registering the hostname again
   creates a new row with a new one. So this function must read the status
   at call time rather than assume an archived deployment's identifier is
   dead forever — which is what "the deployment is active" in the `where`
   clause does.
8. **Nothing is audited and nothing is written.** A public read is not an
   event about a member's action, and a function that writes on every page
   view of every customer site would be a denial-of-service surface with a
   row per request. Phase 7 and Phase 12 own whatever telemetry this
   deserves.
9. **No rate limiting here.** The limiter is the route's (TASK-019a):
   `consume_rate_limit` is granted to `service_role` only, and giving this
   function the right to spend buckets would let the anon key reach the
   limiter directly.
10. **The pgTAP tests own the rules, not the route.** Six "nothing to show"
    cases, the one case that shows, and the grants themselves, all asserted
    in SQL, so a later change to RLS or to a status cannot quietly widen
    what the public can read without a test failing.

## Invariants

- **The function is the only thing `anon` may execute** in this schema.
  After this migration, a test asserts that `anon` holds execute on
  `public.public_disclosure` and on nothing else that reads tenant data.
- **It returns three columns and no identifier.** No row id, no
  organization, no AI system, no hostname, no timestamp, no author.
- **It reveals nothing by distinguishing failures.** Six different reasons
  produce one empty result.
- **It never writes.** `stable`, and no statement in it writes.
- **RLS is unchanged.** No policy is added, altered or dropped; the
  function is the single deliberate way past it, and it is narrower than
  any policy would be.

## Acceptance criteria

- `select * from public.public_disclosure('dep_…')` returns exactly one row
  — the current version's `version`, `language` and `message` — for an
  active deployment of an active system in a live organization whose
  current version is enabled.
- It returns no row when the identifier is unknown, the deployment is
  archived, the AI system is archived, the organization is soft-deleted,
  the system has never published, or the current version is disabled.
- A disabled current version does not fall back to an older enabled one.
- `anon` can execute it; `anon` still cannot select from `deployments`,
  `ai_systems`, `disclosures` or `organizations`.
- An archived deployment that is restored resolves again, under the same
  identifier.

## Required tests

- pgTAP: the one case that shows, and each of the six that do not.
- pgTAP: a disabled current version with an older enabled version below it
  returns nothing.
- pgTAP: the grants — `anon` has execute on the function, and no select on
  the four tables.
- pgTAP: archive, then restore, and the same identifier resolves again.
- Integration (real database, anon key through PostgREST): the same
  function called as the widget's client will call it, proving the grant
  works through the API and that the response carries only the three
  fields.

## Amendment: the PR #35 review

Accepted by Mikołaj Smoliniec (project owner), 2026-09-25. Five
non-blocking notes; two changed the migration, one settled a question the
route would have built on, two are recorded and owed elsewhere.

- **Note 1, the revoke was the one line no test pinned. Applied.**
  `create or replace function` keeps existing privileges, so today's grants
  are stable — but a function cannot be replaced when its return type
  changes, and the later `learn_more_url` task must therefore drop and
  create this one again. A freshly created function is executable by
  `PUBLIC`. The suite as written asserted only who may call, never who may
  not, so it would have passed through that silently. The new assertion
  requires `proacl is not null` before checking that no entry grants
  execute to grantee 0: without that, a function whose privileges were
  never touched has a null `proacl`, `aclexplode` returns nothing, and the
  check passes while `PUBLIC` in fact holds execute by default.
- **Note 2, the tenant predicate in the `max(version)` subquery. Applied.**
  The subquery matched on `ai_system_id` alone while the join two lines
  above binds by `(organization_id, ai_system_id)`. Correct today, because
  `ai_systems.id` is unique and the composite foreign key forces the
  organization to agree — but this is the one function in the schema that
  bypasses RLS, and it was the one place its tenant binding rested on a
  fact stated elsewhere. The predicate changes no plan:
  `(ai_system_id, version)` is still the index and this filters rows
  already fetched.
- **Note 3, `version` stays in the response.** The question was whether a
  field nothing currently reads earns its place on the most exposed
  endpoint in the system. It does: this product exists to make a notice
  citable, and an auditor who fetches the public endpoint and records
  "version 7 was live on this date" has evidence, where the text alone may
  since have changed. README §11 already documents it. The cost is real
  and accepted: anyone holding a public identifier learns how often that
  notice has been revised. Rejected: dropping it until something reads it,
  and replacing it with an opaque digest, which serves a cache but not the
  auditor.
- **Note 4, a mistyped identifier must fail legibly at the boundary.**
  Owed to TASK-019a. `isPublicDeploymentId` refuses anything but exact
  lowercase base32, so a wrong-cased identifier fails the shape check;
  TASK-019a must answer it with a clear refusal rather than letting it
  through to the same empty result a turned-off notice gives. The shape is
  public knowledge, so refusing on shape is no oracle: it says nothing
  about which deployments exist.
- **Note 5, the key rotation now has a concrete consequence.** Owed, not
  here. Before this migration a leaked anon key could do nothing in this
  schema — no execute, no select. After it, a holder of that key can call
  this function directly against PostgREST, outside TASK-019a's route, its
  rate limit and its cache. The exposure is small: a public identifier is
  still needed, 26 base32 characters is about 130 bits, and the data is
  meant for the public. But "it could do nothing" stops being the answer on
  the day this merges, which is a reason to rotate sooner.

### Recorded: why proposal 9 holds

`SUPABASE_ANON_KEY` is read only through `serverEnv()`. There is no
`NEXT_PUBLIC_` Supabase variable and no browser-held key anywhere in the
application, so the only route to this function is the Next.js endpoint,
where TASK-019a's rate limit and cache live. That is an architectural
property rather than a stated rule, and it is what makes "no rate limiting
in the function" correct. A future change that called Supabase directly
from the widget would undo it.

### Out of contract

- `.ai/PLAN.md`: Phase 6's task list now names TASK-019 (the lookup) and
  TASK-019a (the endpoint), and its "shared primitive" paragraph says rate
  limiting landed in Phase 1 (TASK-003c) and is reused here rather than
  written again. The plan is not in this task's Allowed files; the owner
  asked for both corrections on this branch (2026-09-25) under their
  standing permission to edit outside the list.
