# TASK-021 — Installation instructions in the dashboard

## Objective

A member opens a deployment and finds the exact script tag to paste, already
carrying that deployment's public identifier and this installation's host —
with the two Content Security Policy entries a strict site needs, and a plain
statement of whether the tag would render anything today.

This is the last task of Phase 6.

## Owner agent

Frontend

## Dependencies

TASK-014 (`public_id`), TASK-015 (the deployment screens), TASK-017 (the
publishing service this screen reads state from), TASK-020 (the widget and
its documented installation). All merged.

## Allowed files

- app/(dashboard)/dashboard/[organizationId]/deployments/\*\* (the section
  and its fixed text)
- components/dashboard/\*\* (the section's markup)
- features/deployments/\*\* (building the snippet, and reading readiness)
- features/disclosures/disclosure-queries.ts (the narrow current-version
  read this screen needs)
- README.md §11 (that the dashboard generates the tag)
- .ai/PLAN.md (Phase 6 complete)
- tests/\*\*

## Forbidden files

- public/widget.js — the widget is finished; this task documents it, and a
  change here would mean the instructions and the artifact disagreed
- supabase/\*\* — no migration, no policy: every fact this screen shows is
  already readable through row-level security
- app/api/\*\* — no new endpoint; this is a screen
- lib/env/\*\* — `NEXT_PUBLIC_APP_URL` already exists and is already validated

## Decisions

Chosen by Mikołaj Smoliniec (project owner), 2026-09-26:

- **A section on the deployment page**, under the existing Public ID row,
  rather than a page of its own. The deployment is the thing being
  installed and its identifier is already on this screen, so nobody
  navigates to assemble a tag by hand — which is the mistake the generated
  snippet exists to prevent. Cost: the page carries a second purpose beside
  status and archiving, and it grows. Rejected: a dedicated `/install` page
  (one more click at the exact moment somebody is trying to install, for a
  screen that would hold static text) and the disclosure editor (the notice
  belongs to the AI system and the identifier to the deployment, so that
  screen would have to list every deployment — a different, larger screen).
- **The host comes from `NEXT_PUBLIC_APP_URL`**, not from the request. One
  configured truth, already required, already validated by Zod in both env
  modules, and already what `lib/http/api.ts` trusts as this deployment's
  own origin when it refuses a cross-origin write. Every member is handed
  the same snippet whatever host they reached the dashboard on. Cost: a
  preview deployment hands out the production URL — which is right, since
  that is the host a customer should point at, but it means a preview
  cannot be used to install against itself. Rejected: deriving it from the
  request's `Host` header (the snippet would vary by how the dashboard was
  reached, and it would take a displayed value from a request header, which
  this codebase does not do even where the value is not trusted) and a
  relative path with an instruction to prefix the host (it is not
  copy-and-paste, which is the whole point of generating the tag).
- **The screen carries the tag, `data-target` and the two CSP entries.**
  That is what somebody needs at the moment of installing; the CSP entries
  in particular are the most common reason an install fails silently.
  Theming, the endpoint's contract and the Subresource Integrity
  explanation stay in README §11. Cost: a customer who themes leaves the
  dashboard for the README. Rejected: the tag alone with a link (the CSP
  entries would be one hop away from the person who needs them) and all of
  §11 (the deployment page becomes a documentation page, and the same text
  lives in two places that can drift).
- **The screen says plainly when the tag would render nothing**, and links
  to where to fix it. The widget is deliberately silent about a deployment
  with nothing to show — that silence is a security property of the public
  endpoint, which answers the same way for six different causes — so the
  dashboard is the only place that can distinguish them for the person who
  is entitled to know. Cost: one extra query on this page, and the
  deployment screen now reads from the disclosures feature. Rejected:
  showing the snippet unconditionally (a correct install looks broken) and
  hiding it until something is published (it blocks the ordinary order of
  work — tag on the site first, notice published second — and a hidden
  control is harder to understand than an explained one).

## Proposed by the implementer

Awaiting the owner's sign-off.

1. **The snippet is built by a pure function, and the page only renders
   it.** `features/deployments/install-snippet.ts` takes the public
   identifier and the configured application URL and returns the exact text.
   The thing a customer pastes is then testable without a browser, a
   database or a session, and the test asserts the bytes rather than a
   description of them. Rejected: assembling the string in the component,
   which puts the one string customers copy behind a render.
2. **Only the readiness the public function itself uses.**
   `installReadiness` mirrors the conditions in `public.public_disclosure`,
   in the order that function applies them: the deployment must be active,
   its AI system must be active, a version must exist, and that current
   version must be enabled. A closed organization is the fifth condition and
   is not reachable here — nobody reads a deleted organization's dashboard —
   and it is named in the code rather than silently omitted. If the SQL ever
   grows a condition, this is the one other place that must learn it.
3. **The readiness read is its own narrow query**, not `listDisclosures`.
   `readCurrentDisclosureState` selects `version` and `enabled` for the
   newest version only. The history query fetches up to 201 rows with their
   full messages, which is a large read for a yes-or-no question on a screen
   that never shows a message. It goes through the session client and RLS
   like every other read, with `organization.read`: no new privilege.
4. **The snippet is selected by one click, and there is no copy button.**
   `select-all` on the `<pre>`, the idiom the Public ID row on this same
   page already uses, then the reader's own Ctrl+C or ⌘C. The page stays a
   server component with no JavaScript, the interaction works with a
   keyboard and a screen reader without anything to announce, and it cannot
   fail in the contexts where the asynchronous clipboard API is refused.
   Cost, accepted: one keystroke that a copy button would have saved.
   Rejected: a client component using `navigator.clipboard` — a second
   interaction to teach on one screen, a success state to announce, and a
   failure path, for that keystroke.
5. **The state is said in one sentence with a link, not in a badge.** Each
   readiness state has one fixed sentence in the screen's `messages.ts`, as
   every other result on these screens does; nothing the database or a
   request chooses becomes text on the page.
6. **The tag is shown even when nothing will render**, greyed by nothing and
   qualified by the sentence above it. Installing the tag before publishing
   is the ordinary order of work.
7. **`data-target` is shown as a second, optional snippet** rather than as
   prose about an attribute, because the person reading is pasting rather
   than reading.
8. **The CSP entries are generated too**, from the same host, so they cannot
   disagree with the `src` above them.
9. **No identifier but `public_id` reaches the page's new section.** Not the
   deployment's UUID, not the AI system's, not the organization's. The
   section receives exactly what it renders, and a test asserts the rendered
   snippet contains no UUID.
10. **The end-to-end test installs what the dashboard generated.** It reads
    the snippet text out of the rendered page, serves it on a different
    loopback origin, and asserts the notice appears. Nothing else proves the
    instructions are correct rather than merely present — an install
    document that drifts from the product is the failure mode this whole
    task exists to prevent.

## Invariants

- **The snippet names the public identifier and nothing else.** No UUID, no
  organization name, no host of the customer's, no token.
- **The generated tag is the documented installation.** One classic script
  tag, `async`, `src` on the application origin, `data-deployment`.
- **The host is the configured one**, identical for every member and every
  request.
- **Readiness is read through the session client under RLS**, like every
  other read on this screen. The screen adds no privilege and no new
  endpoint.
- **Every string on the screen is fixed text**, chosen by a code.

## Acceptance criteria

- A deployment page shows a script tag carrying that deployment's public
  identifier and the configured host.
- Pasting that exact tag onto a cross-origin page renders the notice.
- A deployment whose AI system has never published says so, and links to
  where to publish.
- A deployment whose current notice is turned off, an archived deployment,
  and one whose AI system is archived each say which, distinctly.
- The section shows no database identifier.
- A viewer sees the instructions; they are not a management control.

## Required tests

- Unit: the snippet's exact text, for a host with and without a trailing
  path; with and without `data-target`; the CSP lines built from the same
  host.
- Unit: every readiness state, including that an archived deployment under
  an archived system reports the deployment.
- Integration, real database: `readCurrentDisclosureState` returns the
  newest version's `enabled`, not an older enabled one; returns nothing for
  a system with no versions; and refuses another organization's system
  through RLS.
- Browser: the deployment page shows the tag; that exact text, served on
  another origin, renders the notice; a system with nothing published shows
  the sentence that says so.
