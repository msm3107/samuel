# TASK-018 — Disclosure configuration screen

## Objective

Let organization members write, publish and turn off an AI system's
disclosure from the dashboard, and read every published version, on top of
TASK-017's queries. Viewers read the same screen without any write control.
This closes Phase 5 apart from TASK-018a (paging the history).

## Owner agent

Frontend

## Dependencies

TASK-010 (the dashboard pages, `access.ts`, the server-action pattern),
TASK-015 (the deployment screens, whose patterns this follows), TASK-016
(`disclosures`, its RLS and triggers), TASK-017 (`features/disclosures/**`,
`publish_disclosure`).

## Allowed files

- app/(dashboard)/dashboard/[organizationId]/systems/[systemId]/disclosure/**
- app/(dashboard)/dashboard/[organizationId]/systems/[systemId]/page.tsx
  (the link to the disclosure screen)
- components/dashboard/**
- features/disclosures/disclosure-form.ts (new: form parsing) and
  disclosure-fields.ts (new: field names and labels, for client
  components); `disclosure.ts`, `disclosure-queries.ts` and `languages.ts`
  stay as TASK-016 and TASK-017 left them
- tests/unit/disclosures/**, tests/integration/disclosures/**,
  tests/security/disclosures/**, tests/e2e/dashboard/**

## Forbidden files

- supabase/migrations/**
- lib/auth/**, lib/security/**, lib/validation/**
- app/api/**
- features/disclosures/disclosure.ts, disclosure-queries.ts, languages.ts

## Screens

| Path                                                        | Permission          | Shows                                                               |
| ----------------------------------------------------------- | ------------------- | ------------------------------------------------------------------- |
| `/dashboard/[organizationId]/systems/[systemId]/disclosure` | `organization.read` | The editor (members only) and every published version, newest first |
| `/dashboard/[organizationId]/systems/[systemId]`            | `organization.read` | TASK-010 and TASK-015's page, plus a link to the screen above       |

## Decisions

Chosen by Mikołaj Smoliniec (project owner), 2026-09-23:

- **The disclosure has its own page under its AI system**, linked from the
  system's page. The system's page already carries its details, its
  deployments, the registration form, the edit form and archiving; a
  version history of up to 200 rows on top of that buries both. A separate
  page also gives Phase 6's installation instructions somewhere to sit.
  Rejected: a section on the system's page (no new route, but one very long
  page whose write controls sit below the history).
- **The history shows every version with its full text**, newest first,
  each with its language, whether it was shown, when it was published and
  by whom. A message is at most 500 characters, so nothing needs hiding,
  and the screen's purpose is evidence: "what did the notice say then" must
  be readable without a further click. Rejected: collapsing older versions'
  text behind a control, and showing older versions as metadata only.
- **The publisher is shown as "You" or "Another member".** `createdBy` is a
  user ID, and names and email addresses live in `auth.users`, which the
  dashboard's session client cannot read. Showing a colleague's email would
  need a new view or function over `auth.users`, with its own grants and
  RLS, which belongs in a reviewed task of its own. The audit events
  already record the exact actor. Rejected: a member directory folded into
  this task, and showing no publisher at all.
- **Turning the notice off is a checkbox in the editor**, "Show this notice
  on the website", pre-filled from the current version. One form, one write
  path. Rejected: a separate one-click button, a second path writing the
  same table with its own messages and tests, and whose effect (a new
  permanent version) is less plain than a checkbox's.

Proposed by the implementer; all eleven accepted on the PR #33 review.
Accepted by Mikołaj Smoliniec (project owner), 2026-09-25.

1. **Server actions calling TASK-017's queries**, as TASK-010 and TASK-015
   do, not `fetch` to the API route. They work without JavaScript, and
   Next.js refuses an action whose Origin does not match the host. The API
   route stays for programmatic callers.
2. **Nothing bound into the action is trusted.** The organization and AI
   system are bound by the page, but bound arguments come back from the
   browser like any form field: the action authenticates, authorizes the
   bound organization, and validates the rest. Every query then uses
   `access.organizationId`.
3. **Refusals on the page are 404**, as in TASK-010 and TASK-015: an
   organization the user is not in, a non-UUID, another organization's
   system, and a system that does not exist all render the same not-found
   page.
4. **The editor is pre-filled with the current version** and carries its
   number in a hidden field, as the AI system edit form carries
   `updatedAt`. Publishing names the version it was based on, so TASK-017's
   stale check can refuse a publish over someone else's newer text. A
   system with no versions sends no such field, which is what a first
   publish means; a field that is present but not a version number is
   refused as stale rather than guessed at.
5. **One message per refusal**, fixed text in a table beside the action:
   changed, unchanged, archived, not found, not permitted, and one per
   invalid field. The action returns a code only.
6. **The message field is a textarea whose line breaks are refused.** A
   disclosure is one line (TASK-016) but up to 500 characters, and a
   single-line input shows about a tenth of that at a time. The textarea
   wraps for reading, and a typed or pasted line break is refused with text
   saying so. Rejected: `<input type="text">`, which cannot hold a line
   break but is unreadable at this length; and collapsing line breaks into
   spaces, which changes what someone wrote without telling them.
7. **Languages are listed by their English name**, in alphabetical order by
   that name, because the dashboard is in English. The stored value stays
   the ISO 639-1 code. A first publish starts with no language chosen, so
   one is always said rather than defaulted.
8. **The current version is the first row of the history, marked as
   current**, not repeated above it. One place to read it means the two can
   never disagree after a publish.
9. **Times are shown in UTC**, in a `<time>` element carrying the exact
   value, as TASK-015 decided.
10. **No dead controls.** Under an archived system the editor is replaced by
    a sentence saying to restore the system first; the history stays
    readable. The action refuses it anyway (`ai_system_archived`), so
    hiding it is only presentation.
11. **The message is rendered as text**, in a paragraph that keeps its
    wrapping and carries `dir="auto"`: no HTML, no markdown, no
    `dangerouslySetInnerHTML`, as Phase 5's invariant requires.

## Amendment: the PR #33 review

Decided by Mikołaj Smoliniec (project owner), 2026-09-25:

- **`CODEX-SECURITY.md` is in `.prettierignore`** (note 1). A standing note
  is a promise; the ignore file is a mechanism, and it works for every agent
  and every session. The owner's untracked review file was reformatted by a
  plain `pnpm format` on 2026-09-23; `format:check`, the gate AGENTS.md
  names, only reads. Rejected: the note alone, which the next forgetful
  `format` defeats. The filename is now visible in the repository, which the
  owner accepted; the contents are not.
- **The textarea holds twice the character limit, and a counter says where
  the real one is** (note 2). HTML's `maxLength` counts UTF-16 units while
  the table and the schema count code points, so a 500-emoji notice, valid
  to the server, was being cut at 250 with nothing said. A code point is at
  most two units, so twice the limit can never cut a notice the server would
  take, and the counter counts code points. Rejected: dropping the cap, which
  lets someone type far past the limit before being told; and leaving it,
  which is silent truncation.
- **A refused caller keeps their draft** (note 3). The two refusal paths
  disagreed: losing permission mid-edit emptied the editor, while a role
  lowered after the check kept what was typed. Both now keep it.
  Authorization still comes before any validation: a refused caller reaches
  no schema, no rule and no query, and the echo is their own input, rendered
  only as a control's value. Rejected: wiping on both paths, one rule at the
  cost of a lost notice.
- **The message limit moved to `disclosure-fields.ts`** (note 4). That
  module exists so client components need not import the schemas, but the
  editor reached `disclosure.ts` for the number, so Zod shipped to the
  browser and the barrier was notional. `disclosure.ts` now takes the number
  from there and re-exports it, so there is still one number. Rejected:
  leaving it and correcting the comment, which keeps PR #29's failure mode:
  a `server-only` import surfacing as a client build error in a file that
  looks unrelated.
- Out of contract, with the owner's standing permission:
  `features/disclosures/disclosure.ts` (a forbidden file) now imports the
  limit rather than declaring it, and `.prettierignore` gained one line.
  Recorded here as the amendment that permission asks for.

## Invariants

- Every page and action calls `requireDashboardSession` itself, then
  `requireOrganizationPermission`; layouts are not relied on.
- The organization used in every query is the authorized one, never a raw
  parameter or form field.
- Only the `message`, `language`, `enabled` and expected-version fields are
  read from the form; any other field, an organization, system, ID,
  version, author or time included, is ignored.
- Authorization comes before validation. A caller without permission is
  refused before any schema runs and before any query; only their own
  submitted text is read back, to keep their draft.
- Hiding a control is presentation. Every write is re-authorized in its
  action, again by the query layer, and again by RLS and the database's
  triggers.
- Errors that reach the page are fixed messages or Next.js's digest, never
  a database message, code or hint.
- `message` is plain text end to end. Nothing in this task renders it as
  markup.

## Acceptance criteria

- A member publishes a first notice, edits it into a second version, turns
  it off as a third, and reads all three; a viewer sees the same history
  with no editor.
- A publish based on an older version is refused with text saying a newer
  version exists, and what was typed stays in the form.
- A publish identical to the current version is refused as unchanged.
- Another organization's disclosures cannot be read or published through
  the screen or its action.
- Under an archived system the editor is replaced by an explanation.
- The flow is keyboard-navigable with visible focus, in a real browser.
- Typecheck, lint, format, and tests pass.

## Required tests

- security (real database): user A's screen and action refuse organization
  B and B's systems; a viewer gets no editor and the action refuses them; a
  forged organization or system bound to the action is refused; smuggled
  form fields are ignored
- security (mocked): the action authorizes before it reads the form
- integration (real database): a first publish, a second version, turning
  the notice off, a stale publish, an unchanged publish, a publish under an
  archived system, the history's order
- unit: form parsing, including the line-break refusal and the version
  field; every result code has a message; every language has a label
- e2e (real Supabase): publish, edit and turn the notice off by keyboard
  alone, with a visible focus outline on every stop
