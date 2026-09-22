## Handoff

### Summary

Deployments are now in the dashboard, which closes Phase 4.

- An AI system's page lists its deployments, active first, and members
  register a hostname there.
- Each deployment has its own page, `/dashboard/[organizationId]/deployments/[deploymentId]`,
  showing both hostname forms, its status, its AI system, its public ID and
  when it was registered. Members archive and restore it there.
- Viewers see both screens without any write control.

There was no TASK-015 contract, so this task adds one. Three decisions are
the owner's (Mikołaj Smoliniec, 2026-09-22); twelve are proposed by the
implementer and await the owner.

### Decisions

1. **Registered on the system's page, with a page of its own per
   deployment** (owner). README §69's `/dashboard/deployments/[id]`, with
   the organization in the path as TASK-010 decided.
2. **The public ID, not an install snippet** (owner). The widget's script
   doesn't exist until Phase 6, so a snippet now would load nothing.
3. **Archive and restore are one button each** (owner), as for systems.
4. **Server actions over TASK-013's queries**, not `fetch` to the API. The
   form's parser calls `validateVerificationTarget` as the route does, and
   only its output is stored.
5. **Nothing bound into an action is trusted**: organization, system,
   deployment and status are each checked again, and the screens refreshed
   after a change are those of the system the database returned.
6. **Refusals on a page are 404**, as in TASK-010.
7. **A registration opens the new deployment**, where its public ID is.
8. **One fixed message per refusal**: TASK-012's seven reasons, plus
   already registered, system archived, system gone and permission lost.
   The typed hostname stays in the input; only a refusal of the hostname
   itself marks the input invalid.
9. **Both hostname forms, fixed left to right** (PR #27 review, note 1;
   PR #26 review, note 3): `<bdi dir="ltr">`, never `dir="auto"`, and the
   ASCII form beside the reading form whenever they differ. The breadcrumb,
   which TASK-010 isolates with `dir="auto"`, uses the ASCII form.
10. **"Inactive" under an archived AI system** (PR #25 review, finding 2),
    on both screens.
11. **Restore explains itself** (PR #28 review, note 1): the text beside
    Archive and Restore says the same public ID comes back, and that a new
    ID means archiving and registering again, with no check history.
12. **No dead controls**: under an archived system, the registration form
    and Restore are replaced by a sentence saying to restore the system
    first. The status form stays mounted, so an archive that leads there is
    still announced. The actions refuse both anyway.
13. **All the system's deployments, active first**, from two queries so
    neither status pushes the other out, each capped at 200 with a note.
14. **A separate status form**, not TASK-010's made generic: a server
    component can't pass the success test as a function.
15. **Times in UTC**, said as such, in a `<time>` element.

### Files changed

- `.ai/tasks/TASK-015-deployment-screens.md` (new): the contract
- `app/(dashboard)/dashboard/[organizationId]/deployments/actions.ts`,
  `messages.ts`, `[deploymentId]/page.tsx` (new)
- `app/(dashboard)/dashboard/[organizationId]/systems/[systemId]/page.tsx`:
  the Deployments section
- `components/dashboard/deployment-form.tsx`,
  `deployment-status-form.tsx`, `hostname.tsx` (new)
- `features/deployments/deployment-form.ts` (new, server-only: the parser)
  and `deployment-fields.ts` (new: the field's name and labels, for client
  components)
- Tests:
  - `tests/unit/deployments/deployment-form.test.ts` (new): 19
  - `tests/security/deployments/deployments-dashboard.supabase.ts` (new):
    16, real database
  - `tests/integration/deployments/deployments-dashboard.supabase.ts`
    (new): 18, real database
  - `tests/e2e/dashboard/ai-systems.supabase.spec.ts`: one more test, in
    the same signed-in session (magic links are rate-limited)

### Security considerations

- Every page and action authenticates and authorizes itself; every query
  uses the authorized organization.
- The registration form reads only `hostname`; a smuggled organization,
  system, status or public ID is ignored (tested).
- A hostname TASK-012 refuses is never stored (tested with `localhost`,
  `169.254.169.254` and `http://[::1]/`).
- Messages are fixed text chosen by code; the only echoed value is the
  typed hostname, rendered as an input's value.
- `features/deployments/deployment-form.ts` imports the server-only
  validator, so client components import from `deployment-fields.ts`. A
  first version imported the field's name from the parser's module and
  broke `next build`; the test subagent caught it.

### Tests

- Required by the contract: all covered.
- Mutation checks, each reverted:
  - the parser skipping TASK-012's validator: 3 security tests fail;
  - a forged status let through: 1 security test fails;
  - Archive shown to a viewer: 1 security test fails;
  - `dir="auto"` on a hostname: 2 unit tests fail;
  - the ASCII form not shown beside an IDN: 1 integration test fails;
  - a restore reported as an archive: 1 integration test fails;
  - a bound AI system not checked as a UUID: 1 security test fails.

### Commands run

See the PR. Each gate was run with the owner's untracked
`CODEX-SECURITY.md` set aside and restored, and its hash verified.

### Remaining concerns

- **No migration in this PR.**
- **The registration form sits on the system's page**, below the list. An
  organization-wide list of hostnames is left for the agency work.
- **The install snippet** belongs to Phase 6, once the widget's address
  exists.
- **Owed from earlier tasks, unchanged:** the database NFC check with the
  next migration on `ai_systems` or `organizations`; TASK-019 must check
  `isPublicDeploymentId` first, require both statuses active, and not
  assume a restore issues a new ID.
