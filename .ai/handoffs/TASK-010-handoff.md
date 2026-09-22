## Handoff

### Summary

Members can list, register, view, edit, archive and restore their
organization's AI systems from the dashboard, on top of TASK-009's queries.
Viewers see the list and each system, with no write control. Each
organization on the dashboard links to its systems.

There was no TASK-010 contract, so this task adds one. The URL shape was the
owner's choice (Mikołaj Smoliniec, 2026-09-21). The other nine decisions
were proposed by the implementer and accepted on the PR #24 review. Accepted by Mikołaj Smoliniec (project owner), 2026-09-22.

### Decisions

1. **The organization is in the path**: `/dashboard/[organizationId]/systems`,
   `…/systems/new` and `…/systems/[systemId]`. Owner's choice.
   - Why: every page authorizes the organization its own URL names, exactly
     as the API routes do. Links work for any member, and two tabs can show
     two organizations.
   - Rejected: a remembered "current organization" cookie, which keeps
     README §69's literal paths but adds hidden state, and slugs, a second
     way to name an organization with one more lookup per page.
   - Downside: a UUID in the address bar, and the paths differ from
     README §69's list.
2. **Server actions, not `fetch` to the API.**
   - Why: the forms work without JavaScript, Next.js refuses a cross-origin
     action (its CSRF protection), and no client code holds a URL or token.
     The organization form already works this way (TASK-007).
   - Rejected: client components calling `/api/…`, which needs JavaScript
     for every write and repeats the route's error mapping in the browser.
   - Downside: two entry points (routes and actions) over the same query
     functions. Both are tested for isolation.
3. **An action trusts nothing bound to it.**
   - The page binds the organization, system and target status into each
     action with `.bind`, and bound arguments come back from the browser as
     ordinary request data.
   - So each action authenticates, authorizes the bound organization,
     checks the system ID is a UUID and the status is `active` or
     `archived`, and then uses `access.organizationId`, never the argument.
   - Tested with forged values: a non-UUID organization, a non-UUID system,
     another organization's system, and statuses `deleted`, `ARCHIVED` and
     empty.
4. **Refusals on a page are 404.**
   - These all render Next.js's not-found page, which can't tell "doesn't
     exist" from "not yours":
     - an organization the user isn't in;
     - a non-UUID;
     - another organization's system;
     - the registration page, for a viewer.
   - Rejected: `forbidden()`, which needs the experimental `authInterrupts`
     flag.
   - Downside: a member demoted mid-session sees "not found" rather than
     "no access".
5. **Actions answer in their form.** A refusal returns a fixed code, and the
   page maps it to fixed text, as the sign-in and organization forms do:
   `not_permitted`, `not_found`, `name_taken` or `invalid` with the fields
   named. Other failures are thrown and render the error page with Next.js's
   digest as the reference.
6. **Edit on the detail page**, not a fourth `/edit` screen. README §69 lists
   three screens, and the form is short.
7. **Archive and restore: one button, no confirmation.**
   - Both are reversible and audited, so a dialog adds a step without
     protecting anything.
   - It is one form either way. Its announcement survives the page
     re-rendering with the new status.
8. **The form keeps what was typed.**
   - Inputs are controlled, because React resets an uncontrolled form after
     its action.
   - A refusal returns the submitted values, each capped at 4,000
     characters, so a forged megabyte isn't sent back.
   - A save returns what was stored, trimmed and NFC-normalized.
9. **The textarea's CR LF line breaks are stored as LF.** Browsers submit
   line breaks as CR LF whatever was typed. Without this, every multi-line
   description would be stored with CR LF, and could fail the 2,000 limit
   the textarea itself enforced.
10. **An unknown `?status=` shows the active systems.**
    - On the API it is a 400.
    - On a page it only picks one of three fixed queries, and a bad bookmark
      shouldn't be an error page.
11. **User text is direction-isolated**: names and providers in `<bdi>`,
    descriptions in `dir="auto"` with their line breaks kept. This is PR
    #23's widget note, applied here because it costs nothing.
12. **Keyboard and focus.**
    - Only native links, buttons and form controls are used.
    - One shared `focus-visible` outline (`components/ui/styles.ts`).
    - A skip link to `<main id="main">`.
    - `aria-current` on the current filter and breadcrumb.
    - Labels and errors tied to their inputs with `aria-describedby`.
    - Each form's result in a live region, marked "Problem:" in words, not
      only by colour.
    - The dashboard's organization form gained the same focus outline.

13. **Stale saves are refused** (review finding 1; owner's choice,
    2026-09-22).
    - The scenario: Anna and Ben open the same system. Ben changes the
      provider and saves; Anna then saves a rename, and her form still holds
      the old provider. Before this, Anna's save silently undid Ben's.
    - Now the form carries the version it was loaded from (`updatedAt`) in a
      hidden field. The update matches it in the same SQL statement, so
      there is no gap between checking and writing. Anna is told "Someone
      changed this system since you opened it", nothing is written, and
      what she typed stays in the form.
    - Why a version and not "send only changed fields": the reviewer's pick.
      Changed-fields-only still loses one of two edits to the same field,
      silently.
    - Why `updatedAt` and not a new counter: it already exists and a trigger
      sets it on every update, so no migration is needed. It is kept as the
      database's exact string; going through `Date` would drop the
      microseconds, and it would never match again.
    - On the API, `expectedUpdatedAt` is optional, so an archive needs no
      read first; a stale one is 409 `ai_system_changed`. The dashboard's
      edit form always sends it, and the action refuses an edit without one
      rather than save it blind.
    - An edit that matches nothing costs one more read, and only then, to
      tell "stale" from "not found". A system in another organization is
      still 404, never 409.
    - Archive and restore name no version: they change only the status, so
      they can't undo an edit.
    - After an archive, the page re-renders with a newer version. An
      untouched edit form takes it on. A form with typed changes keeps the
      older one, so saving them is refused rather than applied over the
      change.
    - Downside: `updatedAt` is now a seventh response field, reversing
      TASK-009's six-field decision (which expected it).
14. **An organization deleted mid-render is "not found"** (review finding 2).
    The pages read it through `organizationOrNotFound`, which turns
    `readOrganization`'s `AuthorizationError` into the not-found page.
    - It runs alongside the list or system query, as before.
    - The review's "saves a read" upside isn't available here. The access
      check reads the membership, not the organization, and returning the
      organization from it would mean changing `lib/auth`, which this task
      may not touch.

### Files changed

- `.ai/tasks/TASK-010-ai-systems-dashboard.md` (new): the contract
- `app/(dashboard)/dashboard/[organizationId]/access.ts` (new): the page
  and action authorization helpers
- `app/(dashboard)/dashboard/[organizationId]/systems/page.tsx`,
  `new/page.tsx` and `[systemId]/page.tsx` (new): the three screens
- `app/(dashboard)/dashboard/[organizationId]/systems/actions.ts` (new):
  create, edit, archive and restore
- `app/(dashboard)/dashboard/[organizationId]/systems/messages.ts` (new):
  paths, result codes and their fixed text
- `app/(dashboard)/dashboard/page.tsx`: organization names link to their
  systems; the create form's focus outline
- `app/(dashboard)/layout.tsx`: the skip link
- `components/dashboard/ai-system-form.tsx`, `ai-system-status-form.tsx`
  and `breadcrumbs.tsx` (new)
- `components/ui/styles.ts` (new): shared class lists
- `features/ai-systems/ai-system-form.ts` (new): form parsing and labels
- `features/ai-systems/ai-system.ts`, `ai-system-queries.ts` and
  `app/api/organizations/[organizationId]/ai-systems/[systemId]/route.ts`:
  `updatedAt`, `expectedUpdatedAt` and 409 `ai_system_changed` (review
  finding 1; out of contract, recorded in the contract's amendment)
- `components/dashboard/.gitkeep`, `components/ui/.gitkeep`: removed
- Tests:
  - `tests/unit/ai-systems/ai-system-form.test.ts` (new): 14 tests
  - `tests/security/ai-systems/ai-systems-dashboard.test.ts` (new): 7
    tests, fakes: which permission each page and action asks for, and a
    deleted organization
  - `tests/security/ai-systems/ai-systems-dashboard.supabase.ts` (new): 18
    tests, real database
  - `tests/integration/ai-systems/ai-systems-dashboard.supabase.ts` (new):
    10 tests, real database, three of them on stale saves
  - TASK-009's suites: the seventh field, and `expectedUpdatedAt` (3 more
    fake-suite tests and 2 more real-database tests)
  - `tests/e2e/dashboard/ai-systems.supabase.spec.ts` (new): 3 tests, real
    browser and Supabase, on one sign-in. One is the organization test
    moved from `tests/e2e/auth/sign-in.supabase.spec.ts`. The keyboard test
    also saves an edit after archiving, and a third test saves from a
    second tab to make the first tab's edit stale.
  - `tests/security/tenant-isolation/support/acting-user.ts`: the harness
    gains `requireDashboardSession`
  - `tests/support/next-interrupts.ts` (new): out of contract, recorded in
    the contract

### Security considerations

- Organization B's list, registration page and systems are not found for
  user A, under either organization's URL. A's actions can't create in B,
  or edit or archive B's system, and B's row is unchanged afterwards.
- A viewer's pages have no form or button. Every write action refuses them
  before any query.
- Smuggled `organizationId`, `organization_id`, `id` and `status` form
  fields are ignored. The system lands in the bound, authorized
  organization, active, with the database's ID.
- A signed-out request to any page or action is redirected to sign-in and
  writes nothing.
- Only the session client is used; nothing new touches the service role.
- No migration.

### Tests

- Required by the contract: all covered.
- Mutation checks, each reverted:
  - the create action asking for `organization.read`: fails 1 fake-suite
    test. The real-database suite still passes, because the query layer's
    role check and RLS refuse the viewer anyway; that is why the fake suite
    exists;
  - page refusals thrown instead of 404: 4 real-database tests fail;
  - the detail page showing write controls to viewers: 1 fails;
  - the bound status not validated: 1 fails;
  - the form reading every field: 1 fails;
  - the status action skipping the UUID check: 1 fails;
  - links without a focus outline: the keyboard e2e test fails.
- After the PR #24 review, each also reverted:
  - no version filter in the update: 3 real-database tests and 1
    fake-suite test fail;
  - the action saving an edit that names no version: 1 real-database
    test fails;
  - the version re-formatted through `Date`, losing microseconds: 4
    real-database tests fail;
  - a deleted organization not mapped to 404: 1 fake-suite test fails;
  - the edit form not taking on the version an archive stored: the
    keyboard e2e test fails.

### Commands run

See the PR. Each gate was run with the owner's untracked
`CODEX-SECURITY.md` set aside and restored, and its hash verified.

### Remaining concerns

- **Two tabs of the same person** are two editors too: saving in one makes
  the other's form stale. That's intended, as the other tab could hold
  older values.
- **A stale form keeps what was typed but not what changed:** the person
  reloads to see the other save, and copies their text over. Showing both
  side by side would be a merge screen, not worth building for a
  four-field form.

- **Magic links in the real-browser suite:** 4 sign-ins against a limit of
  5 per network per 10 minutes. The organization test now shares the
  keyboard test's sign-in to stay under it. A CI retry could still hit the
  limit; that predates this task.
- **Owed from earlier tasks, unchanged:** the database NFC check with the
  next migration on these tables, and the widget's own revocable key and
  direction-isolated rendering.
