## Handoff

### Summary

An AI system's disclosure now has a screen. Members write the notice,
publish it, and turn it off; everyone in the organization reads every
version published so far.

- `/dashboard/[organizationId]/systems/[systemId]/disclosure`: the editor
  (members) and the full history, newest first, the first marked current.
- The AI system's page links to it.

Publishing goes through TASK-017's `publishDisclosure`, so the stale check,
the unchanged check and the archived-system refusal are the database's, not
the screen's. The editor carries the version it was loaded from, so a
publish over someone else's newer text is refused rather than done quietly.

There was no TASK-018 contract, so this task adds one. Four decisions are
the owner's (Mikołaj Smoliniec, 2026-09-23); eleven are the implementer's
and await sign-off.

### Decisions

Owner, 2026-09-23:

1. **Its own page under the AI system**, not a section on the system's page.
2. **Every version with its full text**, not collapsed or metadata only.
3. **The publisher is "you" or "another member"**: `createdBy` is a user ID,
   and `auth.users` is not readable from the dashboard's session client.
4. **Turning the notice off is a checkbox in the editor**, not a separate
   button: one form, one write path.

Implementer (proposed): server actions rather than `fetch` to the API; no
bound argument trusted; refusals on the page are 404; the editor is
pre-filled and carries the current version; one fixed message per refusal;
a textarea whose line breaks are refused; languages by English name with no
default; the current version is the history's first row; UTC times; no dead
controls under an archived system; the message rendered as text. The
contract states each one's reason and what was rejected.

### Files changed

- `.ai/tasks/TASK-018-disclosure-screen.md` (new): the contract
- `app/(dashboard)/dashboard/[organizationId]/systems/[systemId]/disclosure/page.tsx`
  (new): the screen
- `.../disclosure/actions.ts` (new): the publish action
- `.../disclosure/messages.ts` (new): the paths and the fixed text
- `components/dashboard/disclosure-form.tsx` (new): the editor
- `features/disclosures/disclosure-form.ts` (new): form parsing
- `features/disclosures/disclosure-fields.ts` (new): field names, language
  labels
- `app/(dashboard)/dashboard/[organizationId]/systems/[systemId]/page.tsx`:
  a link to the screen
- Tests:
  - `tests/unit/disclosures/disclosure-form.test.ts` (new)
  - `tests/unit/disclosures/disclosure-fields.test.ts` (new)
  - `tests/unit/disclosures/disclosure-messages.test.ts` (new)
  - `tests/security/disclosures/disclosure-action.test.ts` (new)
  - `tests/integration/disclosures/disclosure-screen.supabase.ts` (new, real
    database)
  - `tests/security/disclosures/disclosure-screen.supabase.ts` (new, real
    database)
  - `tests/e2e/dashboard/disclosures.supabase.spec.ts` (new, real browser)

No migration: this task adds none, and none was needed. TASK-017's
`publish_disclosure` is already in production.

### Security considerations

- The action authorizes before it reads the form. A viewer sending an
  invalid body gets `not_permitted` and an empty editor, never `invalid`
  and never their own text echoed back. A mocked test pins the order.
- Nothing bound into the action is trusted. Every query uses
  `access.organizationId`, and the system ID is parsed as a UUID before it
  reaches the database.
- Only `message`, `language`, `enabled` and the expected version are read
  from the form. An organization, system, ID, author or time added to it is
  never looked at.
- A version field that is present but is not a version number is refused as
  `stale`, rather than treated as a first publish, which would write over
  whatever is current.
- Every refusal on the screen is fixed text chosen by a code. No database
  message, code or hint reaches the page.
- The message is plain text end to end: rendered in a paragraph, never as
  markup, as Phase 5's invariant requires.
- Hiding the editor under an archived system is presentation only. The
  query layer, RLS and TASK-016's triggers each refuse it again.

### Tests

Required by the contract: all covered.

Two faults were found and fixed while running the browser suite, both in
the new test rather than in the screen:

- the keyboard walk allowed one Tab from the language picker to Publish,
  but the "show this notice" checkbox sits between them;
- after the third version, which only turned the notice off, the second
  version's text appears twice in the history, so a "is visible" assertion
  was ambiguous. It now asserts both occurrences.

One change to the screen came out of that run: the checkbox now carries the
dashboard's own focus ring rather than relying on the browser's default.

### Commands run

On the final state of the branch, with the owner's untracked
`CODEX-SECURITY.md` set aside and restored:

```
pnpm typecheck                       pass
pnpm lint                            pass
pnpm format:check                    pass
pnpm test                            58 files, 1600 tests, pass
supabase test db --local             7 files, 273 tests, pass
vitest --config vitest.supabase.*    30 files, 375 tests, pass
pnpm test:e2e:supabase               10 tests, pass
next build                           pass
```

The database was reset to the migration head before the database suites, and
again before the browser suite, whose shared sign-in had hit the local
magic-link rate limit after three runs in a few minutes. The limit itself
was not changed.

### Remaining concerns

- **Paging is still owed** (TASK-018a, Phase 5): the history stops at 200
  and says so. The screen has no way to older versions yet.
- **The history is the truth** (PR #32 review, note 2). The screen never
  keeps its own idea of the current version: it publishes against the
  version the server last sent, and a direct Data API insert that added a
  version without the stale check is caught as `disclosure_changed`.
- **A member directory is owed** if the publisher is ever to be named.
  Showing a colleague's name or email needs a reviewed way to read
  `auth.users` for one organization's members.
- **Line endings.** Two files were written with CRLF by a scripted edit and
  normalized to LF before the gates. Worth watching in any future scripted
  edit on Windows.
- **Owed from earlier tasks, unchanged:** TASK-019 must check
  `isPublicDeploymentId` first, require both statuses active, and not assume
  a restore issues a new ID.
