# TASK-010 — AI systems dashboard screens

## Objective

Let organization members list, register, view, edit, archive and restore
their AI systems in the dashboard, on top of TASK-009's queries. Viewers see
the same screens read-only.

## Owner agent

Frontend

## Dependencies

TASK-002 (`requireDashboardSession`), TASK-005
(`requireOrganizationPermission`), TASK-007 (the dashboard page and its
server-action pattern), TASK-009 (`features/ai-systems/**`).

## Allowed files

- app/(dashboard)/dashboard/[organizationId]/**
- app/(dashboard)/dashboard/page.tsx (links from each organization to its
  systems)
- app/(dashboard)/layout.tsx (a skip link)
- components/dashboard/**
- components/ui/**
- features/ai-systems/** (form parsing and labels only; the queries and
  schemas stay as TASK-009 left them)
- tests/e2e/**
- tests/integration/ai-systems/**
- tests/security/ai-systems/**
- tests/security/tenant-isolation/support/acting-user.ts (the harness gains
  `requireDashboardSession`)
- tests/unit/ai-systems/**

Files this adds beyond the list above, recorded here:

- tests/support/next-interrupts.ts: reads Next.js's `notFound()` and
  `redirect()` from their digest, so tests can call pages and actions
  directly with the real `next/navigation`
- components/dashboard/.gitkeep and components/ui/.gitkeep: removed, as the
  folders now have files

## Forbidden files

- supabase/migrations/**
- lib/auth/**
- lib/security/**
- app/api/**

## Screens

| Path                                             | Permission          | Shows                                      |
| ------------------------------------------------ | ------------------- | ------------------------------------------ |
| `/dashboard/[organizationId]/systems`            | `organization.read` | The list, filtered by `?status=`           |
| `/dashboard/[organizationId]/systems/new`        | `systems.manage`    | The registration form                      |
| `/dashboard/[organizationId]/systems/[systemId]` | `organization.read` | The details; for members, edit and archive |

## Decisions

- **The organization is in the path** (`/dashboard/[organizationId]/…`),
  not README §69's literal `/dashboard/systems`. Chosen by Mikołaj Smoliniec
  (project owner), 2026-09-21. Every page authorizes the organization its
  own URL names, as the API routes do; links work for any member, and two
  tabs can show two organizations. Rejected: a remembered "current
  organization" cookie (hidden state, one organization for every tab, links
  that break for other members) and slugs (a second way to name an
  organization, and one more lookup per page).

The rest are the implementer's, awaiting the owner's review:

- **Server actions, not `fetch` to the API.** The forms post to server
  actions that call TASK-009's query functions, as the organization form
  does (TASK-007). They work without JavaScript, Next.js refuses a
  cross-origin action, and there is no client code holding a URL or a
  token. Rejected: client components calling `/api/…`, which would need
  client-side JavaScript for every write and duplicate the route's error
  mapping in the browser.
- **An action trusts nothing it is bound to.** The organization, system and
  target status are bound into each action, and bound arguments reach the
  server as ordinary request data a client can change. Each action
  therefore authenticates, authorizes the bound organization, and validates
  the bound system ID and status itself, exactly as if they had come from a
  form field.
- **Refusals on a page are 404.** An organization the user isn't in, a
  non-UUID, another organization's system, and (for a viewer) the
  registration page all render Next.js's not-found page. Nothing on it
  distinguishes "doesn't exist" from "not yours". Rejected: `forbidden()`,
  which needs Next.js's experimental `authInterrupts` flag.
- **Edit on the detail page**, not a fourth `/edit` screen: README §69 lists
  three, and the form is short.
- **Archive and restore are one button each, with no confirmation.** Both
  are reversible and audited, so a dialog would add a step without
  protecting anything. The button says which one it is.
- **A form keeps what was typed.** An action that refuses returns the
  submitted values (each capped at 4,000 characters) and a fixed error
  code; the page maps the code to a message, as the sign-in and
  organization forms do, so no text of the server's choosing reaches the
  page. After a save, the form shows the stored values: trimmed and
  normalized.
- **An unknown `?status=` shows the active systems.** On the API it is a
  400; on a page it only picks one of three fixed queries, and a bad
  bookmark should not be an error page.
- **User text is direction-isolated** (`<bdi>`, `dir="auto"`), so a
  right-to-left name cannot reorder the text around it. This is the widget
  note from PR #23, applied to the dashboard too, because it costs nothing.
- **Keyboard and focus.** Only native links, buttons and form controls; a
  visible `focus-visible` outline on each; a skip link to the main content;
  the current filter marked `aria-current`; each form's result announced in
  a live region.

## Invariants

- Every page and action calls `requireDashboardSession` itself, then
  `requireOrganizationPermission`; layouts are not relied on.
- The organization used in every query is the authorized one
  (`access.organizationId`), never a raw parameter or form field.
- Only the named form fields are read; any other field is ignored.
- Hiding a control is presentation. Every write is re-authorized in its
  action and again by RLS.
- Errors that reach the page are fixed messages or Next.js's digest.

## Acceptance criteria

- A member registers, edits, archives and restores a system from the
  dashboard; a viewer sees the screens without any write control.
- Another organization's systems cannot be listed, viewed, edited or
  archived through the screens or their actions.
- `/dashboard/[organizationId]/systems` is keyboard-navigable with visible
  focus states, proven in a real browser.
- Typecheck, lint, format, and tests pass.

## Required tests

- security (real database): user A's pages and actions refuse organization
  B and B's systems; a viewer gets no write control and every write action
  refuses them; a forged organization, system ID or status bound to an
  action is refused; smuggled form fields are ignored
- integration (real database): register, edit, name taken, archive,
  restore, restore into a taken name
- unit: form parsing; every result code has a message
- e2e (real Supabase): the whole flow by keyboard alone, with a visible
  focus outline on every stop
