## Handoff

### Summary

A member opens a deployment and finds the tag to paste, already carrying
that deployment's public identifier and this installation's host:

```html
<script
  async
  src="https://your-article50-host/widget.js"
  data-deployment="dep_7k2m4qphr6vt3wzc5nxa7jd2fb"
></script>
```

Beside it: the same tag with `data-target`, the two Content Security Policy
entries built from the same host, and one sentence saying whether the tag
would render anything today.

**No migration, no new endpoint, and nothing the widget does changed.** This
pull request adds a section to a screen, a pure function behind it, and one
narrow query. It completes Phase 6.

### Decisions

Owner, 2026-09-26.

1. **A section on the deployment page**, not a page of its own. The
   deployment is the thing being installed and its identifier is already on
   this screen, so nobody assembles a tag by hand — which is the mistake the
   generated snippet exists to prevent. Cost: the page carries a second
   purpose beside status and archiving.
2. **The host comes from `NEXT_PUBLIC_APP_URL`**, not from the request. One
   configured truth, already required, already Zod-validated, and already
   what `lib/http/api.ts` trusts as this deployment's own origin when it
   refuses a cross-origin write. Every member is handed the same snippet
   whatever host they reached the dashboard on. Cost: a preview deployment
   hands out the production URL — right, since that is where a customer
   should point, but it means a preview cannot install against itself.
3. **The screen carries the tag, `data-target` and the CSP entries.**
   Theming, the endpoint's contract and the Subresource Integrity
   explanation stay in README §11. The CSP entries are here because they are
   the most common reason an install fails silently.
4. **The screen says plainly when the tag would render nothing**, and links
   to where to fix it.

Implementer (proposed): the snippet is built by a pure function; readiness
mirrors the SQL's conditions in the SQL's order; the readiness read is its
own narrow query rather than the history query; one click selects a snippet
and there is no copy button; each state has one fixed sentence; the tag is
shown even when nothing will render; `data-target` is a second snippet
rather than prose; the CSP entries are generated from the same host; only
`public_id` reaches the section; the browser test installs what the
dashboard generated. The contract states each one's reason and what was
rejected. **Awaiting sign-off.**

### Files changed

- `.ai/tasks/TASK-021-widget-install-instructions.md` (new): the contract
- `features/deployments/install-snippet.ts` (new): the exact text, as a pure
  function
- `features/deployments/install-readiness.ts` (new): whether an installed
  tag would render anything
- `features/disclosures/disclosure-queries.ts`,
  `features/disclosures/disclosure.ts`: `readCurrentDisclosureState`
- `components/dashboard/install-instructions.tsx` (new): the section
- `app/(dashboard)/dashboard/[organizationId]/deployments/messages.ts`: one
  fixed sentence per state
- `app/(dashboard)/dashboard/[organizationId]/deployments/[deploymentId]/page.tsx`:
  the section, and the second read that feeds it
- `README.md` §11: the dashboard generates this for you
- `.ai/PLAN.md`: Phase 6 complete, with TASK-021's decision and exit
  criterion

### Security considerations

- **Only the public identifier reaches the section.** Not the deployment's
  UUID, not its AI system's, not its organization's. A real-database test
  slices the rendered section out of the page and asserts no UUID of any
  shape is in it — scoped to the section, because the page's own breadcrumbs
  and links legitimately carry those identifiers, as does the address bar.
- **The host is configured, never taken from the request.** A `Host` header
  cannot change what a member is told to paste onto their site.
- **The snippet is refused rather than generated** if the identifier is not
  a public deployment ID. A snippet with a malformed identifier is worse
  than none: the widget refuses it in the browser and the customer blames
  their own site.
- **The readiness read adds no privilege.** The same session client, the
  same row-level security, `organization.read`. Another organization's
  system returns null — proven against the real database, not assumed.
- **Nothing here weakens the endpoint's silence.** `public_disclosure`
  answers identically for all six reasons there is nothing to show, so it is
  no oracle for which deployments exist. That is exactly why the dashboard
  has to distinguish them: it is the one place where the person asking is
  entitled to the answer.
- **No JavaScript was added to the dashboard.** The section is a server
  component; snippets are selected with `select-all` and copied with the
  reader's own keyboard.

### Tests

Required by the contract: all covered.

- 11 unit tests: the exact snippet text (asserted as bytes, not described),
  a configured URL with a trailing slash, a port or a path, the refusal of a
  malformed identifier, and every readiness state including that an archived
  deployment under an archived system reports the deployment.
- 8 real-database tests: the rendered page's snippet, host and policy
  entries; no identifier in the section; each state reached by doing the
  thing that causes it; and `readCurrentDisclosureState` against the newest
  version, a system with no versions, and another organization's system.
- 3 browser tests, including the one that matters: **the snippet is read out
  of the rendered dashboard and installed, unedited, on a page at another
  origin**, which then has to show the notice. Nothing else proves the
  instructions are correct rather than merely present.

### Two things the tests caught, and what they say

- **An assertion of mine claimed more than the product promises.** "No
  database identifier in the page" failed: the page's breadcrumbs and links
  carry the organization's and the system's identifiers in their hrefs, as
  they must, and as the address bar does anyway. The promise is about the
  installation section, so the assertion is now about the section — and it
  was then checked for vacuity by planting a UUID in that section, which
  made it fail, before being trusted.
- **My section broke a keyboard test, for a real reason.**
  `ai-systems.supabase.spec.ts` located the public identifier as
  `main.locator("code")`, which was unambiguous until this section added
  code elements of its own. The locator now says what it means,
  `main.locator("dl code")`, with a comment saying why. Nothing about the
  behaviour under test changed.

One filter was also corrected rather than weakened: the "says nothing" test
first counted Chrome's own `Failed to load resource: 404` line as the widget
speaking. It is the browser's line, not the widget's, and no page can
suppress it — so the test now measures what the widget says, filtering on
`[article50]` exactly as the widget's own suite does, and it waits for the
lookup to answer rather than for a duration.

### Commands run

On the final state of the branch:

```
pnpm typecheck                       pass (both projects)
pnpm lint                            pass
pnpm format:check                    pass
pnpm test                            65 files, 1730 tests, pass
supabase test db --local             8 files, 290 tests, pass
vitest --config vitest.supabase.*    33 files, 408 tests, pass
pnpm test:e2e:supabase               31 tests, pass
next build                           pass
```

The database was reset to the migration head before the database suites and
again before the browser suite. `CODEX-SECURITY.md`'s sha256 was checked
before and after Prettier: unchanged. Prettier was run on the four changed
files by name rather than across the tree, for the same reason.

### Before merging

- **No migration.** Supabase's "Deploy to production" has nothing to apply.
- **`NEXT_PUBLIC_APP_URL` is now customer-facing.** It was already required
  and already validated, but until now a wrong value broke sign-in
  redirects; from this merge it also appears in the tag members paste onto
  their sites. Worth confirming it is the host customers should point at
  before this reaches production.
- **Preview deployments hand out the production URL**, by the same
  decision. That is correct for customers and means a preview cannot be used
  to install against itself.

### Remaining concerns

- **Phase 6 is complete.** Phase 7 is the verification service (TASK-022 to
  TASK-025), which depends on it.
- **`learnMoreUrl` is owed** as a whole — column, editor field, and the
  widget's link — in one later task, which drops and recreates
  `public.public_disclosure` and must keep the revoke pinned by PR #35's
  note 1.
- **Nothing purges the cache on publish** (PR #36 review): about six minutes
  is the floor on taking a wrong notice down. The installation section now
  tells a member a notice is live the moment it is published, which is a
  little sooner than their visitors will see it.
- **A hard ceiling belongs at the edge** if the public endpoint's alert ever
  fires in anger (PR #36 review, note 3).
- **The key rotation** (PR #35, note 5) is still owed.
- **Owed from earlier tasks, unchanged:** stale-save protection on the AI
  system edit form; a member directory if a publisher is ever to be named.
