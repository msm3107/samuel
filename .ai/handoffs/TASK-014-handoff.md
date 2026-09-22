## Handoff

### Summary

Every deployment now has a public identifier, `public_id`, such as
`dep_jmxeb4fg6ybvfykwxbe4mql72n`: what a customer will put in the widget's
`data-deployment` attribute.

- The database issues it, and nobody can choose or change it.
- Archiving a deployment revokes it until someone restores the
  deployment; registering the hostname again issues a new one.
- The deployment API returns it as `publicId`.
- `lib/security/public-id.ts` recognizes the format, for Phase 6's
  endpoint.

There was no TASK-014 contract, so this task adds one. Four decisions are
the owner's (Mikołaj Smoliniec, 2026-09-22). The implementer proposed six
more, all accepted on the PR #28 review. Accepted by Mikołaj Smoliniec
(project owner), 2026-09-22.

PR #27's note 2 (a fixed hint on the archived-system refusal) lands here,
because this migration touches `deployments`.

### Decisions

1. **Generated in the database** (owner). This amends the plan's
   primitives table, which put generation in `lib/security`; that module
   now only recognizes the format.
2. **`dep_` and 26 lowercase base32 characters, 130 bits** (owner).
3. **Archive = revoke, re-register = new ID** (owner). This covers the
   revocable widget key owed since TASK-009. A rotate action was rejected:
   it breaks the live widget and answers no threat the archive path
   doesn't.
4. **The lookup is TASK-019's** (owner). It must require both the
   deployment and its AI system to be active.
5. **One generator, `private.generate_public_id(prefix)`** (accepted).
   - Each character is one random byte masked to 5 bits, unbiased because
     256 is a multiple of 32.
   - Phase 9's report IDs reuse it.
   - Not exposed through the API: `private` isn't an API schema, and no API
     role may execute it.
6. **A BEFORE INSERT trigger, not a column default** (accepted).
   - A default runs with the inserting user's privileges, and users can't
     execute the generator.
   - The trigger is security definer, sets one column, and overwrites any
     value named on insert.
7. **Existing rows filled by a one-off volatile default** (accepted),
   dropped straight after. On a local database reset to the previous
   migration, two existing deployments got distinct IDs, with no
   `updated_at` change and no new audit event.
8. **The guard keeps the public ID** (accepted), as it keeps the hostname.
9. **`publicId` in the API response** (accepted). Only the organization's
   members read it; the anonymous role has no grant on `deployments`.
10. **An exact format check** (accepted): no trimming or case folding, so
    each ID has one spelling.

Also, as decided on the PR #27 review (note 2): the archived-system trigger
now carries the hint `ai_system_archived`, and the service matches the code
and the hint instead of the message.

### Files changed

- `.ai/tasks/TASK-014-deployment-public-id.md` (new): the contract
- `.ai/tasks/TASK-013-deployments-api.md`: an amendment for `publicId` and
  the hint
- `supabase/migrations/20260922180000_deployment_public_id.sql` (new): the
  generator, column, constraints, trigger, the guard with the public ID
  added, and the archived-system refusal with its hint
- `lib/security/public-id.ts` (new): the format check
- `features/deployments/deployment.ts`, `deployment-queries.ts`: `publicId`
  in the response; hint matching
- Tests:
  - `supabase/tests/deployment-public-id.test.sql` (new): 23 pgTAP tests
  - `supabase/tests/deployments.test.sql`: the guard's new message
  - `tests/integration/database/deployment-public-id.supabase.ts` (new): 5
    tests, real database
  - `tests/unit/security/public-id.test.ts` (new): 22 tests
  - TASK-013's suites: fixtures carry `public_id`; the response has
    `publicId`; a new fake-database test proves the refusal is matched by
    its hint, not its message

### Security considerations

- 130 bits from `gen_random_bytes` (pgcrypto, a CSPRNG); IDs are unique by
  constraint.
- No writer chooses or changes an ID, the table owner included. Users
  can't even name the column.
- The anonymous role can't read deployments at all, so there is still no
  lookup by public ID; TASK-019 adds one, behind its endpoint's rate limit.
- A public ID is never authorization: nothing reads it yet, and the
  contract says so for TASK-019.

### Tests

- Required by the contract: all covered.
- Mutation checks, each reverted:
  - no public-ID trigger: 6 of 23 pgTAP tests fail, 61 of the 73 older
    deployments tests fail, and 11 real-database tests fail;
  - the guard not covering the public ID: 1 pgTAP test fails;
  - a 16-character alphabet (`& 15`): 1 pgTAP test fails (the
    distribution; the shape still matched);
  - no hint on the archived-system refusal: 1 pgTAP and 1 real-database
    test fail;
  - `publicId` not sent: 1 unit test fails;
  - matching the message instead of the hint: 1 fake-database test fails.

### Commands run

See the PR. Each gate was run with the owner's untracked
`CODEX-SECURITY.md` set aside and restored, and its hash verified.

### Remaining concerns

- **Deploy to production:** this PR has a migration. Merging to `main`
  applies it to the production database.
  - The app deploys at the same time. For the seconds between the two, the
    deployment API could answer 500 (the new app selects `public_id` before
    the column exists).
  - Production has no deployments yet, so nothing is affected. The
    migration fills any existing ones.
- **A collision** (two equal IDs, about 2^-65 odds per pair at this scale)
  would fail the unique constraint. The insert would then answer 409
  `deployment_exists`, wrongly, and a retry would succeed. Not worth code.
- **TASK-019 must require both statuses active** when resolving a public ID
  (PR #25, finding 2), and check `isPublicDeploymentId` before any query.
- **Restoring a deployment revives its old ID** (PR #28 review, note 1;
  owner's choice to record, not change). Rotating means archiving and
  registering again, with no verification history carried over.
  TASK-015's screen says so beside Archive and Restore, and TASK-019 must
  not assume a restore issues a new ID.
- **Migrations land before the code that reads them** (PR #28 review, note
  3; owner). A migration adding a column the application reads ships in a
  PR before the code that reads it, or the code tolerates its absence.
- **Owed from earlier tasks, unchanged:** the database NFC check with the
  next migration on `ai_systems` or `organizations`; TASK-015's
  left-to-right, isolated display of `unicodeHostname` (PR #27, note 1).
