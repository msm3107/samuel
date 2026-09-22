## Handoff

### Summary

Organization members can list, read, register, archive and restore
deployments through four routes under
`/api/organizations/[organizationId]/deployments`. Registration runs every
hostname through TASK-012's `validateVerificationTarget` and stores only its
output. The dashboard screen is TASK-015.

There was no TASK-013 contract, so this task adds one. Four decisions are
the owner's (Mikołaj Smoliniec, 2026-09-22). The implementer proposed eight
more, all accepted on the PR #27 review. Accepted by Mikołaj Smoliniec
(project owner), 2026-09-22.

### Decisions

1. **Routes under the organization** (owner). `aiSystemId` is in the body on
   create and an optional list filter. Rejected: nesting under the AI
   system, where every call must match two IDs.
2. **One 400 code per hostname refusal** (owner): `hostname_invalid`,
   `hostname_scheme_not_allowed`, `hostname_credentials_not_allowed`,
   `hostname_private_network`, `hostname_ip_address_not_allowed`,
   `hostname_port_not_allowed`, `hostname_path_not_allowed`. A form can say
   what to fix. The map is typed against TASK-012's codes, so a new code
   there fails the typecheck until it gets one here.
3. **`aiSystemStatus` on every deployment** (owner), read in the same query
   through the composite foreign key. This is how PR #25's finding 2 reaches
   the API: a screen can mark a deployment of an archived system as
   inactive. Creating or restoring under one is 409 `ai_system_archived`.
4. **`hostname` and `unicodeHostname`** (owner), the second from Node's
   `domainToUnicode` on the server, since browsers can't decode punycode.
   TASK-015 must show the ASCII form beside the Unicode one whenever they
   differ (PR #26, note 3).
5. **Only TASK-012's output is stored** (accepted). Zod checks the body's
   shape; the validator decides the hostname and supplies the stored form.
6. **An `aiSystemId` from nowhere, or from another organization, is 404
   `ai_system_not_found`** (accepted), from the composite foreign key. Both
   cases get the same answer.
7. **409 `deployment_exists`** on create or restore (accepted), from
   TASK-011's unique index; only the caller's own system is compared.
8. **PATCH is `{ status }` only, with no version** (accepted). A single
   switch has nothing to overwrite; a clashing restore is refused by the
   database.
9. **Response fields** (accepted): `id`, `aiSystemId`, `aiSystemStatus`,
   `hostname`, `unicodeHostname`, `status`, `createdAt`, `updatedAt`.
10. **Lists as for AI systems** (accepted): by hostname, capped at 200, with
    `truncated`. A filter naming a foreign or missing system lists nothing.
11. **No audit calls in the application** (accepted): TASK-011's triggers
    write them, without the hostname.
12. **The hostname is never logged** (accepted); refusals log their code.

How the archived-system refusal is recognized: TASK-011's trigger raises
`23514` with its own message, while the hostname CHECK raises `23514` with
a constraint message. The service matches the trigger's exact message.
Any other `23514` is a fault (500), since a validated hostname can't fail
the CHECK. Checked against the real database before writing the code.

### Files changed

- `.ai/tasks/TASK-013-deployments-api.md` (new): the contract
- `features/deployments/deployment.ts` (new): schemas, the hostname code
  map, the response type
- `features/deployments/deployment-queries.ts` (new): the service and
  serializer
- `app/api/organizations/[organizationId]/deployments/route.ts` (new): GET
  (list), POST
- `app/api/organizations/[organizationId]/deployments/[deploymentId]/route.ts`
  (new): GET, PATCH
- Tests (written by a Sonnet subagent, reviewed and mutation-checked by the
  coordinator):
  - `tests/unit/deployments/deployment.test.ts`: 41 tests
  - `tests/security/deployments/deployments-api.test.ts`: 32 tests, fake
    database
  - `tests/security/deployments/deployments-api.supabase.ts`: 15 tests,
    real database, cross-tenant
  - `tests/integration/deployments/deployments-api.supabase.ts`: 10 tests,
    real database, a member's round trip

### Security considerations

- Organization B's deployments can't be listed, read, created or archived
  from A. B's deployment ID or AI system ID under A's URL is a 404, the
  same as an ID that doesn't exist, and B's rows are unchanged afterwards.
- Viewers read; members and up write. Refusals happen before the body is
  read or any deployment is queried.
- Every target in Phase 4's exit criteria is refused through the route
  with its code, before any insert. Neither the refused hostname nor any
  database message appears in a response or a log.
- The session client only, so RLS applies to every query.

### Tests

- Required by the contract: all covered.
- Mutation checks, each reverted:
  - storing the raw input instead of the validator's output: 1 fake and 1
    real-database test fail;
  - no validator: 10 fake and 2 real-database tests fail;
  - the update not filtered by organization: 1 fake test fails. The
    real-database tests still pass, because RLS stops it anyway;
  - every `23514` read as "archived": 1 fake test fails;
  - `aiSystemStatus` taken from the deployment: 1 real-database test fails;
  - no Unicode form: 2 fake and 1 real-database test fail;
  - POST needing only `organization.read`: 1 real-database test fails (the
    service's own role check still refuses the viewer);
  - `23503` not mapped: 1 fake and 1 real-database test fail.

### Commands run

See the PR. Each gate was run with the owner's untracked
`CODEX-SECURITY.md` set aside and restored, and its hash verified.

### Remaining concerns

- **TASK-015 must show both hostname forms** when they differ, and mark a
  deployment of an archived system as inactive. `unicodeHostname` can hold
  right-to-left letters, so it is shown left-to-right and isolated
  (`<bdi dir="ltr">`) beside the ASCII form, never with `dir="auto"` (PR #27
  review, note 1; owner's choice).
- **TASK-014** adds the public identifier, and must treat a deployment of
  an archived system as inactive too (PR #25, finding 2).
- **The archived-system refusal is matched by its message.** If TASK-011's
  trigger message changes, the service answers 500 instead of 409. A
  real-database test would catch that. The next migration that touches
  `deployments` gives the trigger a fixed hint, `ai_system_archived`, and
  the service then matches the code plus the hint (PR #27 review, note 2;
  owner's choice).
- **Owed from earlier tasks, unchanged:** the database NFC check with the
  next migration on `ai_systems` or `organizations`; the widget's own
  revocable key and direction-isolated rendering.
