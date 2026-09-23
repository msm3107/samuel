## Handoff

### Summary

Members can now read an AI system's disclosure history and publish a new
version through the API:

- `GET /api/organizations/[organizationId]/ai-systems/[systemId]/disclosures`:
  the versions, newest first (the first is the one the widget will show),
  and the system's status.
- `POST` the same path: publishes a version. It is refused with 409
  `disclosure_changed` if it was based on an older version than the
  current one, and 409 `disclosure_unchanged` if it changes nothing.

The migration also carries the two rules owed on older tables:

- **AI systems refuse deletes**, the service role included, unless their
  organization is being deleted (PR #31 review, note 1).
- **Names are checked for NFC** in the database: organization names, and
  AI system names, providers and descriptions (PR #23 review).

There was no TASK-017 contract, so this task adds one. Four decisions are
the owner's (Mikołaj Smoliniec, 2026-09-22), and four more come from the
PR #31 review. The implementer proposed eight, all accepted on the PR #32
review. Accepted by Mikołaj Smoliniec (project owner), 2026-09-23.

On the PR #32 review (owner): the migration and the code ship together,
as a known exception to the migration-before-code rule (note 1); paging
the history becomes TASK-018a in Phase 5 (note 3).

### Before merging: check production for non-NFC names

The NFC constraints are validated against existing rows (owner's
decision). If a production row isn't NFC, the migration fails, nothing
changes, and the deploy stops. The application has normalized every write
since #23, so none is expected. To be sure, run this read-only query in
the Supabase SQL editor for production. It should return no rows:

```sql
select 'organizations' as table_name, id
from public.organizations
where name is not nfc normalized
union all
select 'ai_systems', id
from public.ai_systems
where name is not nfc normalized
  or provider is not nfc normalized
  or description is not nfc normalized;
```

### Decisions

1. **Routes under the AI system** (owner).
2. **A stale publish is refused**, 409 `disclosure_changed` (owner), in
   `public.publish_disclosure`, under TASK-016's per-system lock.
3. **NFC validated in the migration; it fails loudly** (owner).
4. **An unchanged publish is refused**, 409 `disclosure_unchanged`
   (owner), in the table's own trigger, so it holds for every writer.
5. **AI systems refuse deletes** (PR #31 review, note 1; owner).
6. **`23503` is 404 `ai_system_not_found`; `42501` is 403** (PR #31
   review). Another organization's system reaches `23503` under the
   caller's own organization; under the other organization's path the
   route's permission check refuses first.
7. **The archived system is matched by code and hint** (PR #31 review).
8. **The one-line rule is mirrored** in `lib/validation/text.ts` (PR #31
   review, note 2).
9. **The stale check is a database function; plain inserts stay allowed**
   (accepted). See the contract for why.
10. **Hints `disclosure_changed` and `disclosure_unchanged`, code `PT409`**
    (accepted).
11. **`23505` is `disclosure_changed`** (accepted): only a concurrent direct
    insert can reach it.
12. **The GET is one query**, capped at 200, with `aiSystemStatus`
    (accepted).
13. **`enabled` is required** (accepted).
14. **The message is counted in code points** (accepted).
15. **Response fields** include `createdBy` (accepted).
16. **No audit calls in the application** (accepted).

### Files changed

- `.ai/tasks/TASK-017-disclosure-publishing.md` (new): the contract
- `supabase/migrations/20260922200000_disclosure_publishing.sql` (new)
- `features/disclosures/disclosure.ts` (new): the schema and response
  type
- `features/disclosures/disclosure-queries.ts` (new): the history and
  publish
- `app/api/organizations/[organizationId]/ai-systems/[systemId]/disclosures/route.ts`
  (new)
- `lib/validation/text.ts`: `hasLineOrParagraphSeparator`
- Tests:
  - `supabase/tests/disclosure_publishing.test.sql` (new): 31 pgTAP tests
  - `supabase/tests/deployments.test.sql`, `supabase/tests/disclosures.test.sql`:
    "deleting the AI system cascades" became "deleting the AI system is
    refused, and its rows stay" (the owner's change of rule, not a
    weakened test); the organization cascades are kept
  - `tests/unit/disclosures/disclosure.test.ts` (new): 90
  - `tests/unit/validation/text.test.ts`: the separator check
  - `tests/integration/disclosures/disclosures-api.supabase.ts` (new): 14,
    real database
  - `tests/security/disclosures/disclosures-api.supabase.ts` (new): 7, real
    database
  - `tests/security/disclosures/disclosures-api.test.ts` (new): 11
  - `tests/integration/database/ai-systems.supabase.ts`: the service role
    can't delete an AI system

### Security considerations

- **Visibility before anything else.** `publish_disclosure`, like
  TASK-016's trigger, first requires the caller to see the organization
  and system pair. A stranger gets `23503` whatever that system has, even
  when naming a version, and never takes its lock.
- **The function runs as the caller.** RLS and every TASK-016 trigger
  apply to its insert as to a direct one. A direct Data API insert skips
  only the stale check, which protects a person from an accident; history
  keeps every version either way.
- The route checks `disclosures.manage` before reading the body, and the
  query layer checks again.
- The message is plain text end to end; nothing here renders it, and the
  audit row carries no metadata.
- No one, the service role included, deletes an AI system except by
  deleting its organization.

### Tests

- Required by the contract: all covered.
- Mutation checks, each applied and then reverted (the database ones
  followed by a reset):
  - no stale check in the function: 2 real-database and 3 pgTAP tests
    fail;
  - no visibility check in the function: at first nothing failed. The
    trigger's own check still answers `23503` for a stranger with
    `expectedVersion: null`, but with a number the function would reach
    the stale check and answer `disclosure_changed`. A pgTAP test for that
    case was added, and it fails;
  - no unchanged check: 1 real-database and 3 pgTAP tests fail;
  - no delete trigger on AI systems: 1 real-database and 2 pgTAP tests
    fail;
  - no NFC constraints: 2 pgTAP tests fail;
  - the route asking only for `organization.read`: at first nothing failed,
    because the query layer refuses a viewer too. A test was added: a
    viewer sending an invalid body gets 403 (authorization comes before validation),
    not 400. It fails under the mutation;
  - `23503` unmapped: 2 security tests fail;
  - `disclosure_unchanged` unmapped: 1 integration test fails;
  - no separator check: 2 unit tests fail;
  - no same-origin check: 1 test fails.
- Not a mutation: replacing the code-point count with Zod's `max` changed
  nothing, because Zod 4 already counts code points. The schema now uses
  `max`, and the 500- and 501-emoji tests pin the behaviour.
- The browser suites were not run: nothing here is on a screen.

### Commands run

See the PR. Each gate was run with the owner's untracked
`CODEX-SECURITY.md` set aside and restored, and its hash verified.

### Remaining concerns

- **The migration and the code ship together** (PR #32 review, note 1;
  owner). The route calls `publish_disclosure`, which exists only after
  the migration; until then a publish would answer 500. No screen calls
  it before TASK-018, so nothing can reach that window. The
  migration-before-code rule holds from TASK-018 on.
- **Paging the history is TASK-018a** (PR #32 review, note 3; owner), in
  Phase 5.
- **This PR has a migration.** Supabase's "Deploy to production" applies
  it on merge. It changes `ai_systems` and `organizations` (new
  constraints and a delete trigger) and replaces TASK-016's version
  trigger. Run the query above first.
- **For TASK-018's contract:**
  - the history the endpoint returns is the truth, never the screen's own
    idea of the current version: a direct Data API insert can add a
    version without the stale check (PR #32 review, note 2);
  - show `disclosure_changed` with a way to load the newer version, and
    `disclosure_unchanged` as "nothing changed", not as an error of the
    person's text;
  - render the message as text only;
  - `createdBy` is a user ID; showing a name needs a membership lookup.
- **`create_organization` doesn't normalize.** The application sends NFC,
  and the new constraint refuses anything else, but a direct RPC call with
  a decomposed name now fails with the table's `23514` rather than the
  function's own `22023`. No request the application sends reaches it.
- **Owed from earlier tasks, unchanged:** TASK-019 must check
  `isPublicDeploymentId` first, require both statuses active, and not
  assume a restore issues a new ID. The NFC check is no longer owed.
