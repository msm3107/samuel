## Handoff

### Summary

Members can list, register, view, edit, archive and restore their
organization's AI systems from the dashboard, on top of TASK-009's queries.
Viewers see the list and each system, with no write control. Each
organization on the dashboard links to its systems.

There was no TASK-010 contract, so this task adds one. The URL shape was the
owner's choice (Mikołaj Smoliniec, 2026-09-21); the other decisions are the
implementer's and await the owner's review.

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
- `components/dashboard/.gitkeep`, `components/ui/.gitkeep`: removed
- Tests:
  - `tests/unit/ai-systems/ai-system-form.test.ts` (new): 14 tests
  - `tests/security/ai-systems/ai-systems-dashboard.test.ts` (new): 6
    tests, fakes: which permission each page and action asks for
  - `tests/security/ai-systems/ai-systems-dashboard.supabase.ts` (new): 18
    tests, real database
  - `tests/integration/ai-systems/ai-systems-dashboard.supabase.ts` (new):
    7 tests, real database
  - `tests/e2e/dashboard/ai-systems.supabase.spec.ts` (new): 2 tests, real
    browser and Supabase. One is the organization test moved from
    `tests/e2e/auth/sign-in.supabase.spec.ts`, to share a sign-in.
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

### Commands run

See the PR. Each gate was run with the owner's untracked
`CODEX-SECURITY.md` set aside and restored, and its hash verified.

### Remaining concerns

- **Magic links in the real-browser suite:** 4 sign-ins against a limit of
  5 per network per 10 minutes. The organization test now shares the
  keyboard test's sign-in to stay under it. A CI retry could still hit the
  limit; that predates this task.
- **Owed from earlier tasks, unchanged:** the database NFC check with the
  next migration on these tables, and the widget's own revocable key and
  direction-isolated rendering.
