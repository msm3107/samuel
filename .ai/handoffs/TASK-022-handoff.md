## Handoff

### Summary

`public.verification_checks`: append-only evidence that a deployment was
checked. The table, its constraints, its row-level security, and the
triggers that make "never mutate historical evidence" a property of the
database rather than a rule the application remembers. README §20's
integrity columns are created here, nullable and unpopulated.

**Nothing writes it yet.** TASK-023 fetches, TASK-024 inspects, TASK-025
schedules. The schema lands first because a migration adding something the
application reads ships before the code that reads it.

**This pull request contains a migration.** Supabase's "Deploy to
production" applies it on merge.

### Decisions

Owner, 2026-09-26.

1. **`status` with a nullable `failure_code`.** `status` is `success` or
   `failure`; `failure_code` carries the reason and is null exactly when the
   status is success, enforced by a check constraint. `SUCCESS` is therefore
   not a stored code: `status` already says it, and a second encoding of one
   fact is a second thing that can be wrong. README §19 is amended to say so.
2. **Idempotency is the database's.** `check_window` plus
   `unique (deployment_id, check_window)`. A cron that fires twice, or
   overlaps itself, cannot write two rows for one window; the second gets a
   unique violation and TASK-025 reads that as "already done". Cost: a
   column §5's list did not name, now added to it.
3. **A deployment with nothing to show is not checked**, so `disclosure_id`
   is `not null`. There is no notice to look for, and every evidence row
   names the exact version it was checked against.
4. **`metadata` holds facts about the check, never page content.** A
   customer's page can contain anything, including personal data of their
   own visitors (§34).

Implementer (proposed): only the service role writes; append-only is four
triggers rather than a convention; the tenant binding is in composite
foreign keys; `checked_at` is the database's clock and `check_window` the
writer's; text with check constraints rather than enums; the three
observation columns are nullable and each null means one stated thing;
`disclosure_version` is what was observed, not what was expected; the hash
columns are shape-constrained; `metadata` is a bounded object; viewers read;
the indexes are Phase 8's two reads plus the disclosure cascade; and the
code list lives in `features/verification/`. The contract states each one's
reason and what was rejected. **Awaiting sign-off.**

### Files changed

- `.ai/tasks/TASK-022-verification-checks-schema.md` (new): the contract
- `supabase/migrations/20260926120000_verification_checks.sql` (new): the
  table, constraints, indexes, triggers, grants and policy
- `supabase/tests/verification_checks.test.sql` (new): 26 assertions
- `supabase/tests/deployments.test.sql`,
  `supabase/tests/disclosures.test.sql`: the truncate assertions, below
- `features/verification/verification-check.ts` (new): the statuses, the
  failure codes, the row schema and the serializer
- `tests/unit/verification/verification-check.test.ts` (new)
- `tests/security/verification/verification-checks-isolation.supabase.ts`
  (new)
- `README.md` §5 and §19; `.ai/PLAN.md` Phase 7

### Security considerations

- **No user can write evidence.** No insert grant for `authenticated` and no
  insert policy: a member who could insert could manufacture their own
  compliance history. Proven through the Data API as a signed-in user, not
  only as the table owner.
- **No one updates a row**, the service role included — it has `select` and
  `insert` and nothing else — and a trigger refuses an update even for the
  table owner.
- **Rows go only with their organization.** A deployment and an AI system
  are each archived rather than deleted (§33), so in practice the
  organization is the only door. The trigger still admits a deployment or
  disclosure that is already gone, because a cascade visits rows in no
  promised order.
- **The tenant binding is in the foreign keys.** `(organization_id,
deployment_id)` and `(organization_id, disclosure_id)` reference the unique
  keys TASK-011 and TASK-016 created for this table, so a row naming one
  organization's deployment and another's disclosure is refused by the
  database rather than by a code path. Both directions are asserted in pgTAP.
- **The two outcome columns cannot disagree.**
  `check ((status = 'success') = (failure_code is null))`.
- **No customer page content is stored.** `metadata` is a bounded object of
  facts about the check; the rule is in a table comment where a future
  writer will meet it, not only in this handoff.
- **Every member of a live organization reads its own checks and none of
  anyone else's**, under RLS. Another organization's row is absence, not an
  error — the same answer as for a row that does not exist.
- **This is not tamper-proof against database-owner access**, which can
  disable a trigger or set `session_replication_role = replica`, exactly as
  `audit_events` says of itself. That is what §20's chain is for, and why
  its columns exist now rather than after customers rely on the table.

### What this changed about two existing tables, and why it is better

Adding foreign keys into `deployments` and `disclosures` means Postgres now
refuses a bare `truncate` of either with `0A000`, "cannot truncate a table
referenced in a foreign key constraint" — **before** those tables' own
no-truncate triggers can run. Their pgTAP files asserted the trigger's
`42501`, so both failed.

The protection is unchanged in substance and stronger in form: two
independent refusals instead of one. But the fix was not to change the
expected error code and move on, because that would leave the guarantee
resting on another table continuing to exist. Both files now assert **both**:
a bare `truncate` is refused by the foreign key, and `truncate ... cascade`
gets past that rule and is still refused by the table's own trigger. Each
file gained one assertion rather than having one rewritten.

### Tests

- **pgTAP, 26 assertions**: `checked_at` is the database's; a success cannot
  carry a reason and a failure must; `SUCCESS` and an invented code are both
  refused; a second row for one deployment and window is refused and the next
  window is not; a window beginning after the check is refused; another
  organization's deployment and another's disclosure are each refused; the
  observation columns' bounds; a 64-character hex digest is accepted in both
  hash columns and anything else refused; update, delete and truncate refused
  for the table owner; a delete from inside another trigger refused while the
  parents exist; deleting a deployment and deleting an AI system each refused,
  deleting the organization allowed and taking the checks with it; and the
  grants for `authenticated`, `anon` and `service_role`.
- **Real database, through the Data API as a signed-in user** — where the
  grants and the policy decide rather than the table owner's session: a
  viewer reads their own organization's evidence and none of another's, and
  cannot insert, update or delete. The "sees exactly one" assertion first
  proves both rows exist, so it is not passing on an empty table.
- **Real database, against the live constraint**: every code the application
  knows is inserted and has to land, and `SUCCESS` is refused. There is no
  direct SQL connection from these suites, only PostgREST, so the constraint
  is exercised rather than read.
- **Unit**: the migration's code list equals `VERIFICATION_FAILURE_CODES` —
  the direction the database test cannot cover, a code the database accepts
  that the application has never heard of — plus the row schema's two
  coherence rules and the serializer's omissions.

### Commands run

On the final state of the branch:

```
pnpm typecheck                       pass (both projects)
pnpm lint                            pass
pnpm format:check                    pass
pnpm test                            66 files, 1735 tests, pass
supabase test db --local             9 files, 318 tests, pass
vitest --config vitest.supabase.*    34 files, 413 tests, pass
pnpm test:e2e:supabase               31 tests, pass
next build                           pass
```

The database was reset to the migration head before the database suites and
again before the browser suite. `CODEX-SECURITY.md`'s sha256 was checked
before and after Prettier: unchanged. Prettier was run on changed files by
name rather than across the tree, for the same reason.

### Before merging

- **This migration runs on merge.** It is additive: one new table, its
  indexes, four triggers, three grants and one policy. It creates no
  function that an existing one calls and alters no existing table.
- **It changes how `truncate` fails on two existing tables**, as above.
  Nothing in the application truncates anything; this is visible only to
  tests and to a database owner.
- **Nothing reads or writes the new table yet.** The application is
  unchanged in behaviour by this pull request.

### Remaining concerns

- **TASK-023 is next**: the SSRF-hardened fetch, with redirect
  revalidation. `lib/security/verification-target.ts` (TASK-012) already
  decides whether a hostname may be fetched at all; TASK-023 is the fetch
  itself and its bounds, each mapping to its own code.
- **A retention policy is still undefined** (§33), and this is the table it
  is about. Evidence grows by one row per active deployment per window,
  forever. It was already owed; it now has a table.
- **The hash chain is reserved, not built.** The columns accept a digest and
  nothing writes one. If §20's chain is wanted, it is a later task, and the
  ordering question — what "previous record" means across deployments — is
  not answered here.
- **Owed, unchanged:** `learnMoreUrl` as a whole; a cache purge on publish;
  a hard ceiling at the edge if the public endpoint's alert fires; key
  rotation plus `git stash drop`; stale-save protection on the AI system
  edit form; a member directory if a publisher is ever to be named.
