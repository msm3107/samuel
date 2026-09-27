## Handoff

### Summary

HTML inspection and the failure-code mapping (TASK-024): the bytes TASK-023
fetches, decoded to text and searched for the installation, with the result
mapped to `WIDGET_NOT_FOUND` or `DEPLOYMENT_ID_MISMATCH`. It also adds the
inspection keys to `metadata`'s whitelist, in its own migration, as TASK-023
said it would.

**Nothing calls it yet.** TASK-025 composes `fetchVerificationPage` with
`inspectVerificationPage` and writes the evidence row.

**This pull request contains a migration.** Supabase's "Deploy to production"
applies it on merge. It is additive: one check constraint dropped and re-added
with three more allowed keys, on a table that holds no rows. No failure code is
added or removed.

**README §18's fourth question is now answered "not by HTML inspection", and
that is a launch limit.** See below — it is the one thing in this task a reader
should not discover later.

### Decisions

Owner, 2026-09-27.

1. **Presence means our own script tag, served from our own host.** A
   `<script>` whose `src` resolves to this installation's host and
   `/widget.js`, carrying `data-deployment`. The HTML contains nothing else of
   ours — the notice is rendered by JavaScript §18 forbids executing — so the
   tag is the only observable fact, and it carries both of §18's answerable
   questions in one place. A tag pointing at a **copy** of `widget.js` on the
   customer's own domain is not presence: the widget resolves its
   configuration endpoint from its own script URL, so a copy asks the
   customer's host for a notice, gets their 404, and renders nothing. Cost: a
   customer proxying `/widget.js` through their own domain — unsupported, but
   sincere — collects `WIDGET_NOT_FOUND`, so the reason records that a
   foreign-origin tag was seen.
2. **`DISCLOSURE_VERSION_MISMATCH` is reserved, and the gap is recorded.** The
   version the widget renders arrives from our endpoint after a `fetch`, so it
   is never in the customer's HTML. Nothing in this task emits the code and
   `disclosure_version` is null in every row it produces. Cost: a stale notice
   is indistinguishable from a current one until §18's isolated browser
   environment exists.
3. **The HTML is searched by a scanner written here, with no new dependency.**
   §56 asks whether platform functionality can solve it first, and the
   dependency would exist to be fed hostile bytes from arbitrary websites
   inside our own process, to find one element by name. Cost: HTML is hard, so
   the scanner is only as good as its tests, and it is deliberately not a
   parser.
4. **Charset: byte order mark, then the header, then `<meta charset>`, then
   UTF-8.** The order a browser uses, because a page read with the wrong
   encoding is a `WIDGET_NOT_FOUND` recorded against a customer who complied.
   Cost: a sniff is a second source of truth for the same fact, so the stored
   `charset` is the only record of which one won.

Implementer: fifteen proposals, awaiting sign-off. Three modules rather than
one, so a tokenizer bug and a matcher bug — which fail in opposite directions —
cannot hide in each other's tests; all three in `features/verification/`
because they have one consumer; the scanner skips what a browser would not run
as markup rather than what a parser would not parse; character references
decoded only for the forms a URL can carry; the expected host read from
`serverEnv()` and never passed in; `WIDGET_PATH` imported from the module that
builds the installation; a tag matched on host and path, ignoring scheme, query
and fragment; the fetch's success result now carrying `finalUrl`; a
a `widget_reason` vocabulary of seven; a tag of ours with no usable identifier
mapped to `DEPLOYMENT_ID_MISMATCH` with `widget_detected: true`; `widget_tags`
as a count and never an identifier; the first of several tags reported; a
non-HTML body not scanned at all; `charset` stored as the canonical encoding
name; and the whole body scanned rather than a prefix. The contract states each
one's reason and what was rejected.

### Files changed

- `.ai/tasks/TASK-024-verification-inspection.md` (new): the contract
- `features/verification/html-scan.ts` (new): the tokenizer — knows nothing
  about Article50.js
- `features/verification/decode-body.ts` (new): bytes to text, and what they
  were read as
- `features/verification/inspect-page.ts` (new): the only module that knows
  what an installation looks like
- `features/verification/verification-check.ts`: `WIDGET_REASONS`, and three
  `metadata` keys
- `features/verification/fetch-page.internal.ts`,
  `features/verification/fetch-page.ts`: the success result now carries
  `finalUrl`, and `VerificationFetchSuccess` is a named type
- `supabase/migrations/20260927140000_verification_inspection_keys.sql` (new)
- `supabase/tests/verification_checks.test.sql`: three assertions
- `tests/unit/verification/html-scan.test.ts` (new)
- `tests/unit/verification/decode-body.test.ts` (new)
- `tests/security/verification/verification-inspection.test.ts` (new)
- `tests/unit/verification/verification-check.test.ts`: the widened whitelist
- `README.md` §6, §18, §19; `.ai/PLAN.md` Phase 7

### Security considerations

- **Nothing fetched is executed.** The scanner reads text and returns tag names
  and attributes. No `eval`, no parser that could run a script, no DOM.
- **A tag a browser would not run is not a tag that was found.** Comments,
  doctypes and bogus comments, the raw-text contents of `script`, `style`,
  `textarea`, `title`, `xmp`, `iframe`, `noembed` and `noframes`, the contents
  of `noscript` — which needs scripting disabled, and our widget is a script —
  and the contents of `template`, which are parsed but never executed. Each is
  a way to carry the text of an installation while showing a visitor nothing,
  and each has a test naming the trick it refuses.
- **The direction of the errors was chosen deliberately.** A false positive
  writes a success row for a site that discloses nothing, which is the one
  error a compliance record must not make; a false negative is a failed check a
  customer can dispute. So the matching is strict, the tokenizer's own limits
  all point at finding a tag a browser would not run, and the reasons exist so
  a false negative can be explained rather than merely recorded.
- **The expected origin is not reachable by a caller.** It comes from
  `serverEnv()`. PR #40 note 3's lesson one module later: a caller who could
  pass the origin could pass the customer's own, and every self-hosted copy
  would verify as present. The public identifier _is_ a parameter, because it
  names which deployment is being checked.
- **No identifier read off a customer's page is stored.** It would belong to
  another organization, so copying it into this organization's evidence row is
  a cross-tenant leak through the one column §34 protects. `widget_tags` is a
  count; the pgTAP suite proves a key for the identifier does not exist, and a
  unit test proves the other deployment's ID appears nowhere in the metadata.
- **`widget_reason` is privacy-safe by construction, not by care.** Seven fixed
  strings, bounded as a value by the row schema and as a key by the migration.
- **`charset` stores the encoding standard's own name**, never the label the
  page wrote — so the stored value comes from a fixed list rather than from
  customer bytes.
- **A mis-decode is treated as our problem, not the customer's.** An
  unrecognized charset label falls through instead of failing the check, and a
  label mapping onto the `replacement` encoding is refused: honouring it would
  turn every byte into U+FFFD and guarantee a `WIDGET_NOT_FOUND` on a page we
  can otherwise read. That protection exists to stop a browser being tricked
  into reinterpreting a page, and we render and execute nothing.
- **`toLowerCase` is not length-preserving** (U+0130 becomes two code units),
  so the scanner folds a name at a time and never uses a folded copy of the
  document for indices. A folded copy would have silently misaligned every
  position after the first such character — on a page that merely contains
  Turkish text.
- **No regular expression runs over the whole body.** The scanner scans; the
  only patterns are on short attribute values and on the first 1024 bytes,
  which is what bounds them.

### Verification

```
pnpm typecheck                      pass (app and widget projects)
pnpm lint                           pass
pnpm format:check                   pass
pnpm test                           pass — 71 files, 1922 tests
pgTAP (supabase test db --local)    pass — 9 files, 329 tests
real-database vitest                pass — 34 files, 413 tests
Playwright (browser suite)          pass — 31 tests
next build                          pass
```

The database was reset to the migration head before the database suites and
again before the browser suite; the widened constraint applied cleanly to an
empty table. `CODEX-SECURITY.md`'s sha256 was checked before and after
Prettier: unchanged. Prettier was run on changed files by name rather than
across the tree, for the same reason.

### Before merging

- **This migration runs on merge.** One check constraint dropped and re-added
  with three more allowed keys. The table holds no rows, so validation is
  instant, and the new list is a strict superset of the old one — no row could
  fail it even if rows existed.
- **It alters no other table**, creates no function and no trigger, and touches
  no failure code.
- **Nothing calls the inspection yet.** The application is unchanged in
  behaviour.

### Remaining concerns

- **§18's fourth question is unanswered at launch, by design.** A stale notice
  reads as a current one. `DISCLOSURE_VERSION_MISMATCH` and
  `disclosure_version` exist and stay empty until the isolated browser
  environment does. README §18 says so where it asks the question.
- **TASK-025 is next**: the cron route authenticated by `CRON_SECRET`,
  idempotent per deployment per window, composing the fetch and the inspection
  and writing the row.
- **TASK-025 still owes a catch per deployment** (PR #40 note 4). Both
  `fetchVerificationPage` and `inspectVerificationPage` reject when the fault
  is ours — a hostname that will not parse, an invalid environment, an expected
  identifier that is not one. None of those is a customer's failed check, and a
  rejection that reaches the scheduler unguarded stops a whole run.
- **The scanner's limits are stated in its own file**, and they all point one
  way: it can find a tag a browser would not run. It does not know that
  `</template>` inside a raw-text element is text, it cannot know a real parser
  discarded a subtree, and it treats `<script/>` inside `<svg>` like any other
  script start tag. A page would have to be built deliberately to reach any of
  them.
- **A pre-rendered notice is not accepted as presence.** A customer who
  pre-renders their pages with a headless browser has a real installation this
  task reports as missing. Rejected for now because it is a second matcher to
  keep in step with the widget for a page shape almost nobody serves; it is the
  first thing to revisit if a customer reports it.
- **TASK-025's window size is still a storage decision** (PR #39 note 1), and
  it still has to account for a fifteen-second worst case per deployment.
- **A per-organization or per-host concurrency limit is still not written.**
- **Owed, unchanged:** `learnMoreUrl` as a whole; a cache purge on publish; a
  hard ceiling at the edge if the public endpoint's alert fires; key rotation
  plus `git stash drop`; stale-save protection on the AI system edit form; a
  member directory if a publisher is ever to be named; §20's hash chain and its
  ordering question; the TASK-010 to TASK-021 sign-offs.
