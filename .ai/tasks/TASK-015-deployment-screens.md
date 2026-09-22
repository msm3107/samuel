# TASK-015 — Deployment screens

## Objective

Let organization members register where an AI system is deployed, open
each deployment, and archive or restore it from the dashboard, on top of
TASK-013's queries and TASK-014's public ID. Viewers see the same screens
read-only. This closes Phase 4.

## Owner agent

Frontend

## Dependencies

TASK-010 (the dashboard pages, `access.ts`, the server-action pattern),
TASK-012 (`validateVerificationTarget`), TASK-013 (`features/deployments/**`),
TASK-014 (`publicId`).

## Allowed files

- app/(dashboard)/dashboard/[organizationId]/deployments/**
- app/(dashboard)/dashboard/[organizationId]/systems/[systemId]/page.tsx
  (the system's deployments and the registration form)
- components/dashboard/**
- features/deployments/deployment-form.ts (new: form parsing, server-only
  through TASK-012's validator) and deployment-fields.ts (new: the field's
  name and the labels, for client components); the queries and schemas
  stay as TASK-013 and TASK-014 left them
- tests/e2e/dashboard/**
- tests/integration/deployments/**
- tests/security/deployments/**
- tests/unit/deployments/**

## Forbidden files

- supabase/migrations/**
- lib/auth/**
- lib/security/**
- app/api/**
- features/deployments/deployment.ts, deployment-queries.ts

## Screens

| Path                                                     | Permission          | Shows                                                                                      |
| -------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------ |
| `/dashboard/[organizationId]/systems/[systemId]`         | `organization.read` | TASK-010's page, plus the system's deployments; for members, a form to register a hostname |
| `/dashboard/[organizationId]/deployments/[deploymentId]` | `organization.read` | One deployment; for members, archive or restore                                            |

## Decisions

Chosen by Mikołaj Smoliniec (project owner), 2026-09-22:

- **Deployments are registered on their AI system's page; each has its own
  page at `/dashboard/[organizationId]/deployments/[deploymentId]`.** That is
  README §69's `/dashboard/deployments/[id]` with the organization in the
  path, as TASK-010 decided. A deployment always belongs to one system, so
  it is registered where the system is, with no system picker. Rejected:
  a separate deployments section (`/deployments` and `/deployments/new`,
  two screens §69 doesn't list, and a picker that must leave out archived
  systems; an organization-wide list can come with the agency work), and
  nesting under the system (`/systems/[systemId]/deployments/[id]`: two IDs
  to check on every render, and links from TASK-019 and Phase 7 would need
  the system's ID too).
- **The public ID, not the install snippet.** The page shows `publicId` as
  selectable text and says the install code comes with the widget
  (Phase 6). The widget's script and its address don't exist yet, so a
  snippet now would tell customers to install a tag that loads nothing.
- **Archive and restore are one button each, with no confirmation**, as
  for AI systems. Restoring undoes an archive and brings the same public ID
  back, and both are audited. The text beside the button says what happens
  to the widget.

Proposed by the implementer; all twelve accepted on the PR #29 review. Accepted by Mikołaj Smoliniec (project owner), 2026-09-22.

1. **Server actions calling TASK-013's queries**, as TASK-010's forms do,
   not `fetch` to the API. They work without JavaScript, and Next.js
   refuses a cross-origin action. The registration form's parser,
   `parseDeploymentForm`, calls `validateVerificationTarget` exactly as the
   route does, and the action stores only its output: one check, two
   callers.
2. **Nothing bound into an action is trusted.** The organization, AI system,
   deployment and target status are bound by the page, but come back from
   the browser like any form field. Each action authenticates, authorizes
   the bound organization, and validates the rest. Every query then uses
   `access.organizationId`, and the screens revalidated after a change are
   those of the system the database returned, not the bound one.
3. **Refusals on a page are 404**, as in TASK-010: an organization the user
   isn't in, a non-UUID, and another organization's deployment all render
   the same not-found page.
4. **A registration opens the new deployment's page**, where its public ID
   is, as registering a system opens the system.
5. **One message per refusal.** Each of TASK-012's seven reasons, and each
   refusal of the insert (already registered, system archived, system gone,
   permission lost), has fixed text saying what to change. The action
   returns only a code, and the hostname as typed (at most 2,048
   characters) to put back in the input.
6. **Both hostname forms, direction-fixed** (PR #27 review, note 1). The
   reading form (`unicodeHostname`) is shown in `<bdi dir="ltr">`, never
   `dir="auto"`: a hostname is read left to right whatever its script, and
   `auto` would let a right-to-left label reorder the name. Whenever it
   differs from the stored ASCII form, the ASCII form is shown beside it
   (PR #26 review, note 3), so `аpple.com` with a Cyrillic "а" shows as
   `xn--pple-43d.com` too.
7. **"Inactive" when the AI system is archived** (PR #25 review, finding 2).
   A deployment of an archived system says it is inactive and why, whatever
   its own status, because the widget and the verifier ignore it. Its
   system's page says the same once, above the list.
8. **Restore explains itself** (PR #28 review, note 1). The text beside
   Archive says the public ID stops working until the deployment is
   restored; the text beside Restore says it brings the same ID back. Both
   say how to get a new ID: archive, then register the hostname again,
   which starts with no verification history.
9. **No dead controls.** Under an archived system the registration form is
   replaced by a sentence saying to restore the system first, and an
   archived deployment's Restore button by the same sentence. The actions
   still refuse both on their own (`ai_system_archived`), so hiding them is
   only presentation.
10. **The system's page lists all its deployments, active first**, each with
    its status, sorted by hostname within each group, up to TASK-013's 200
    with a note when cut short. Two queries, one per status, so neither
    group is pushed out by the other; a system has few deployments, so no
    filter links.
11. **A separate status form component**, not TASK-010's made generic. A
    server component can pass a client component only data, not a function
    to tell success from refusal, so a shared one would need the result
    tables passed in as props; about seventy lines repeated is the smaller
    cost, and TASK-010's file stays untouched.
12. **Times are shown in UTC**, in a `<time>` element carrying the exact
    value. The server renders the page and doesn't know the reader's time
    zone; UTC, said as such, is never wrong.

## Amendment: the PR #29 review

Decided by Mikołaj Smoliniec (project owner), 2026-09-22:

- **The register action authorizes before it reads the form** (note 2),
  as the API routes check permission before reading the body. A refused
  caller gets `not_permitted` and an empty value, not what they typed.
  Nothing leaked before, since the hostname check is pure computation with
  a size cap; this is for consistency. A security test pins it.
- **Browser tests share one sign-in** (note 1): two runs of this PR failed
  on the magic-link rate limit. This becomes its own task, TASK-015a,
  before Phase 5: sign in once and reuse the saved session
  (Playwright's `storageState`) across the test files. The rate limit
  itself stays as it is.

## Invariants

- Every page and action calls `requireDashboardSession` itself, then
  `requireOrganizationPermission`; layouts are not relied on.
- The organization used in every query is the authorized one, never a raw
  parameter or form field.
- Only the `hostname` field is read from the registration form; any other
  field, an organization, system, status or public ID included, is ignored.
- The only hostname ever passed to `createDeployment` is
  `validateVerificationTarget`'s output.
- Hiding a control is presentation. Every write is re-authorized in its
  action and again by RLS and the database's triggers.
- Errors that reach the page are fixed messages or Next.js's digest.
- Host names are never rendered with `dir="auto"`.

## Acceptance criteria

- A member registers a hostname under a system, opens it, sees its public
  ID, archives it and restores it; a viewer sees the screens without any
  write control.
- Another organization's deployments cannot be listed, viewed, registered
  under, archived or restored through the screens or their actions.
- Each of TASK-012's refusals shows its own message, and the input keeps
  what was typed.
- A deployment of an archived system is marked inactive on both screens.
- The flow is keyboard-navigable with visible focus, in a real browser.
- Typecheck, lint, format, and tests pass.

## Required tests

- security (real database): user A's pages and actions refuse organization
  B, B's systems and B's deployments; a viewer gets no write control and
  every write action refuses them; a forged organization, system,
  deployment or status bound to an action is refused; smuggled form fields
  are ignored; a hostname TASK-012 refuses is never stored
- integration (real database): register (and land on the new page), each
  hostname refusal, already registered, register under an archived system,
  archive, restore (same public ID), restore under an archived system,
  restore into a taken hostname
- unit: form parsing; every result code has a message; every TASK-012
  failure has a code with a message
- e2e (real Supabase): register, archive and restore by keyboard alone,
  with a visible focus outline on every stop, and the public ID shown
