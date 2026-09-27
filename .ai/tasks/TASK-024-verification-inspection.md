# TASK-024 — HTML inspection and the failure-code mapping

## Objective

Read the bytes TASK-023 returns and answer README §18's remaining questions:
was Article50.js present, and was the expected deployment ID present. Decode
the body to text first, find the installation without executing anything, and
map what was found to `WIDGET_NOT_FOUND` or `DEPLOYMENT_ID_MISMATCH`.

It also adds the inspection keys to `metadata`'s whitelist, in its own
migration, as TASK-023 said it would.

Nothing calls it yet. TASK-025 composes the fetch and the inspection, and
writes the row.

## Owner agent

Security

## Dependencies

TASK-014 (`isPublicDeploymentId`), TASK-020 (`public/widget.js` — the
installation this task looks for), TASK-021 (`WIDGET_PATH`,
`buildInstallSnippet` — the installation the dashboard hands out), TASK-022
(`verification_checks`, its codes, its `metadata` column), TASK-023
(`fetchVerificationPage` and its result). All merged.

## Allowed files

- features/verification/\*\* (the scanner, the decoder, the inspection, and
  `metadata`'s shape)
- supabase/migrations/\*\* (one new migration: the inspection keys)
- supabase/tests/\*\* (its assertions)
- README.md (§6's whitelist, §18's four questions, §19's mapping)
- .ai/PLAN.md (Phase 7)
- tests/\*\*

## Forbidden files

- public/widget.js — the installation is read, never adjusted to suit the
  verifier. If the two disagree the widget is right, because it is what runs
  in a visitor's browser.
- features/deployments/\*\* — `WIDGET_PATH` and `isPublicDeploymentId` are
  imported, not restated and not changed
- lib/security/verification-target.ts, features/verification/fetch-page\*.ts —
  the transport is finished; this task consumes its result and adds nothing
  to it
- every existing migration, TASK-023's whitelist included — the inspection
  keys are added by replacing that constraint, never by editing the file
  that created it
- app/\*\*, components/\*\* — no screen shows a verification result until
  Phase 8
- supabase/migrations/20260926120000_verification_checks.sql's failure code
  list — this task adds no code to §19. All three inspection codes were
  reserved in TASK-022.

## Decisions

Chosen by Mikołaj Smoliniec (project owner), 2026-09-27:

- **Presence means our own script tag, served from our own host.** A
  `<script>` whose `src` resolves to this installation's host and
  `/widget.js`, carrying `data-deployment`. Why: the HTML only ever contains
  the tag — the notice itself is rendered by JavaScript, which §18 forbids
  executing — so the tag is the only observable fact, and it carries both of
  §18's answerable questions in one place. A tag pointing at a copy of
  `widget.js` on the customer's own domain is **not** presence: the widget
  resolves its configuration endpoint from its own script URL, so a copy asks
  the customer's own host for a notice, gets their 404, and renders nothing.
  The notice really is absent, and recording a success would be false
  evidence in the direction that matters most. Cost, accepted: a customer who
  proxies `/widget.js` through their own domain — an unsupported
  installation, but a sincere one — collects `WIDGET_NOT_FOUND`, so the
  reason records that a foreign-origin tag was seen, which is the one fact
  that tells them what to change. Rejected: accepting a pre-rendered
  `[data-article50="notice"]` element as well (a second matcher, a second
  thing to keep in step with the widget, for a page shape almost nobody
  serves) and accepting the tag from any origin (it records a success for a
  page where no notice can render).
- **`DISCLOSURE_VERSION_MISMATCH` is reserved, and the gap is recorded.**
  This task never emits it, and `disclosure_version` is stored null. Why: the
  version the widget renders comes from our own endpoint after a `fetch`, so
  it is never in the customer's HTML — §18's fourth question is not
  answerable by HTML inspection, and §18 already anticipates the isolated
  browser environment that would answer it. Cost, accepted: a launch where a
  stale notice is indistinguishable from a current one, which is why README
  §18 now says so in the section that asks the question rather than in a
  handoff nobody reads. Rejected: reading a `data-version` attribute off a
  pre-rendered notice (only coherent if a pre-rendered notice counts as
  presence, which it does not) and resolving the version from our own
  database (it records what we already know rather than what a visitor saw,
  so a success would assert something the page never showed — and
  `disclosure_version` is documented as what was observed, not what was
  expected).
- **The HTML is searched by a scanner written here, with no new dependency.**
  A tokenizer that skips what a browser would not run as markup, then matches
  tags. Why: §56 asks whether platform functionality can solve it and says to
  avoid a dependency for a trivial function — and the alternative would parse
  hostile input from arbitrary websites inside our own process, which is the
  surface §56 exists to ask about. Cost, accepted: HTML is genuinely hard, so
  the scanner is only as good as its tests, and it is deliberately not a
  parser — it builds no tree and resolves no implied end tag. Rejected:
  `parse5` or `node-html-parser` (a spec-following parse, at the cost of that
  surface and of a dependency whose whole job is to be fed hostile bytes) and
  a regular expression over the body (it matches inside comments, inside
  `<script>` bodies and inside a documentation code sample, so a site merely
  _describing_ our tag would verify as compliant).
- **Charset: the header, then `<meta charset>`, then UTF-8.** The charset
  named by `Content-Type` if `TextDecoder` accepts it, otherwise a
  `<meta charset>` sniff in the first 1024 bytes as browsers do, otherwise
  UTF-8. An unknown label falls back rather than failing the check. Why: Node
  ships full ICU, so windows-1252, ISO-8859-2, Shift_JIS and GBK all decode,
  and a mis-decoded page is a false `WIDGET_NOT_FOUND` — a failure recorded
  against a customer who did comply. Cost, accepted: a sniff is a second
  source of truth for the same fact, and the stored `charset` is the only
  record of which one won. Rejected: UTF-8 always (correct for most of the
  web, but a Shift_JIS page can decode into bytes where an ASCII tag no
  longer reads as one) and the header only, never sniffing (a page that
  declares its encoding solely in a `<meta>` tag — still common on older
  sites — decodes wrongly, and that is the population most likely to have a
  hand-pasted tag).

## Proposed by the implementer

Sixteen. Fifteen proposed with the task and agreed on the PR #41 review with proposal 7 amended; proposal 16 came out of that review's blocking finding. Accepted by Mikołaj Smoliniec (project owner), 2026-09-27.

1. **Three modules, not one.** `html-scan.ts` finds tags in bytes-turned-text
   and knows nothing about Article50.js; `decode-body.ts` turns bytes into
   text; `inspect-page.ts` is the only one that knows what a widget tag looks
   like. Why: the scanner is the part that will be fed hostile input, and it
   is worth testing against nasty HTML without a deployment identifier
   anywhere in the test. Rejected: one module (its tests could not separate a
   tokenizer bug from a matching bug, and those fail in opposite directions —
   a tokenizer bug invents presence, a matching bug denies it).
2. **They live in `features/verification/`, not in `lib/`.** Why: one
   consumer. §5's `lib/` holds cross-cutting primitives, and a `lib/html`
   with a single caller is speculative generality; if the isolated browser
   environment ever becomes a second consumer, moving the file is a rename.
   Rejected: `lib/validation/` (a tokenizer accepts and rejects nothing) and
   `lib/html/` (a namespace for one file).
3. **The scanner skips what a browser would not run as markup.** Comments
   (`<!-- -->`, including the `<!-->` short form), doctypes and bogus
   comments, the raw-text contents of `script`, `style`, `textarea`, `title`,
   `xmp`, `iframe`, `noembed` and `noframes`, the contents of `<noscript>`,
   and the contents of `<template>`. Why each: a tag in a comment or in
   another script's body is text, not an installation; `<noscript>` content
   is not parsed as markup when scripting is enabled, and our widget needs
   scripting, so a tag hidden there never runs; a `<template>`'s contents are
   parsed but never executed. Every one of these is a way to make a page look
   compliant without rendering a notice, which is why the scanner's job is
   defined by what runs rather than by what parses. Cost, accepted: this is a
   tokenizer's approximation of a parser — it does not track that
   `</template>` inside a raw-text element is text, and it cannot know that
   a `<script>` is in a subtree the browser discarded.
4. **Attribute values have their character references decoded, but only the
   ones that can appear in one.** `&amp;`, `&lt;`, `&gt;`, `&quot;`,
   `&apos;`, and numeric references. Why: without it a `src` whose query a
   CMS escaped is a false failure, and a false failure is recorded against a
   complying customer. Why not the full named table: it is 2231 entries, none
   of which can appear in an origin, in `/widget.js`, or in 26 characters of
   base32 — so the full table would be a dependency-sized answer to a
   question this list already closes.
5. **The expected host is read from `serverEnv()`, never passed in.** The
   inspection takes the fetched page and the expected public identifier, and
   resolves our widget URL itself. Why: PR #40 note 3's lesson, one module
   later — a caller who could pass the origin could pass the customer's own,
   and every self-hosted copy would verify as present. The public identifier
   is the caller's because it names which deployment is being checked; the
   origin is not, because it is the same for every check this installation
   performs. Rejected: a parameter with `buildInstallSnippet`'s purity (that
   function's output is text a human pastes, and a wrong origin there is
   visible in a unit test; here a wrong origin is invisible and it dissolves
   the finding).
6. **`WIDGET_PATH` is imported from `features/deployments/install-snippet.ts`.**
   Why: verification must look for the path the dashboard hands out, and one
   constant is the only way to be sure it does — a second copy of
   `"/widget.js"` is a way for the two to disagree silently, and the
   disagreement would show up as every customer failing at once.
7. **A tag is ours by host, path and executability, ignoring the scheme, the
   query and the fragment.** Amended on the PR #41 review, which falsified the
   original: host and path are not sufficient, because an element carrying both
   and a non-JavaScript `type` loads nothing. The element must also be one a
   browser would run — see proposal 16. The exclusions below stand unchanged.
   The host as `URL` normalizes it, the pathname exactly
   `/widget.js`. Why ignore the scheme: a protocol-relative `//host/widget.js`
   on a plain-HTTP page resolves to `http://host/widget.js`, which is our
   widget — our host redirects to HTTPS and the browser follows. Why ignore
   the query: a cache-busting `?v=2` still loads our widget, because our
   server serves it regardless. There is no security cost to either, because
   this is not authentication of the customer's page — it is reading their
   installation, and the tag either loads our code or it does not.
8. **Relative `src` values resolve against the URL the body came from.**
   Which means the fetch's success result now carries `finalUrl` beside the
   `final_host` it already stored. Why not rebuild it from
   `metadata.scheme` and `metadata.final_host`: both are optional in the row
   schema, because a check that failed at DNS observed neither, so a consumer
   would have to guess a default for a value the transport already knows
   exactly — and a redirect hop may carry a path, so the base is not always
   `/`.
9. **`widget_reason`, because two stored codes cover seven installations.**
   `NOT_HTML`, `NO_WIDGET_TAG`, `FOREIGN_ORIGIN`, `NO_WIDGET_SRC`,
   `NO_DEPLOYMENT_ID`, `MALFORMED_DEPLOYMENT_ID`, `OTHER_DEPLOYMENT`. Why:
   exactly PR #40 note 2's argument one task later — `WIDGET_NOT_FOUND` over
   "you have no tag", "your tag points at your own domain" and "your home
   page is a PDF" is one code over three different fixes, and this is the
   failure class a customer must act on. Privacy-safe by construction: six
   fixed strings, no customer data. `NO_WIDGET_SRC` — a tag carrying
   `data-deployment` whose `src` loads no widget of ours — exists for a
   narrower reason than the others: without it, a page that plainly has a tag
   would be told it has none, and a reason that is _wrong_ is worse than a
   reason that is vague. Rejected: three more §19 codes (§19 governs
   `failure_code`, and every consumer of that list would have to handle a
   detail about one code) and a log line (a log is not evidence a customer can
   be shown).
10. **A tag of ours with no usable identifier is `DEPLOYMENT_ID_MISMATCH`, not
    `WIDGET_NOT_FOUND`.** Why: §18 asks two questions, and this is the honest
    pair of answers — Article50.js _was_ present, the expected deployment ID
    was _not_. So the row records `widget_detected: true` beside a failure
    code, which the schema permits deliberately: TASK-022 constrains only
    that a _success_ means the widget was found.
11. **`widget_tags` counts how many tags of ours the page carries.** Why: the
    widget documents one install per page, and zero against two is the
    difference between a missing tag and a page that renders one notice
    against the last tag's identifier. It is a count, never an identifier —
    a deployment ID found on the page belongs to some other organization, and
    putting it in this organization's evidence row would be a cross-tenant
    leak through a column §34 exists to protect.
12. **When several tags of ours fail, the first in document order is the
    reason.** Why: deterministic and explicable, and it is the tag a reader
    of the page meets first. Rejected: a precedence order over the reasons
    (it would report a tag further down the page as though it were the
    installation, and "the first one" is the only rule that needs no table).
13. **A body whose `Content-Type` is not an HTML type is not scanned at
    all.** `text/html` and `application/xhtml+xml`; an absent header is
    scanned, because a browser would sniff and render it. Why: a `text/plain`
    home page containing markup renders as text in a browser, so no notice
    appears, and scanning it would find a tag that never runs. The
    `Content-Type` is already stored, so the row explains itself.
14. **`charset` stores the canonical encoding name, never the label the page
    wrote.** `new TextDecoder(label).encoding` maps every accepted label to
    one of the WHATWG names. Why: privacy-safe by construction rather than by
    care — the stored value comes from a fixed list, not from the page, which
    is the same reason `redirect_reason` is safe to store. Rejected: storing
    the raw label (a 64-byte string a customer chose, in a column §34 governs)
    and a `charset_source` key beside it (`content_type` is already stored, so
    a header-declared charset is already visible, and "meta tag" against
    "defaulted" is a distinction with no different action attached).
15. **The scanner reads the whole decoded body, not a prefix.** Why: a tag
    may legitimately sit just before `</body>`, which is where the dashboard's
    own instructions suggest putting it, and 1 MiB is already the bound
    TASK-023 accepted. Rejected: scanning the first 64 KiB (it would fail
    exactly the installation we recommend, on a heavy page).
16. **A tag counts only if a browser would execute it.** Added on the PR #41
    review, which found the blocking defect this closes. Following the
    specification's "prepare the script element" steps: the element counts when
    its `type` is absent, empty, a JavaScript MIME type essence, or `module`,
    and when `nomodule` is absent from a classic script. Why the whole
    sixteen-entry MIME list rather than the three anyone writes: every entry is
    a spelling a browser executes, and omitting one would report a working
    installation as missing. Both comparisons are trimmed and case-folded, so
    `type=" TEXT/JavaScript "` passes — a customer's odd spelling is not a
    finding. It lives in `inspect-page.ts` rather than in the scanner, because
    the scanner is deliberately ignorant of Article50.js and returns tags for
    any element name: "would a browser run this" is a question about our
    matching rules. Rejected: folding the reason into `NO_WIDGET_SRC` (it would
    send the customer to inspect the one part they got right) and reading
    `type` in the tokenizer (it would make a generic scanner answer a question
    about scripts).

## Amendment: the PR #41 review

Accepted by Mikołaj Smoliniec (project owner), 2026-09-27. One blocking
finding and two notes; all three changed code, and the blocking one changed a
proposal.

- **Blocking: a one-attribute edit recorded a success for a page that displays
  no notice. Fixed.** Nothing looked at `type` or `nomodule`, so
  `type="text/plain"` on the exact tag the dashboard hands out gave
  `ok: true`, `widgetDetected: true`, `widget_tags: 1` — and TASK-025 would
  have written an append-only, never-expiring record asserting a disclosure was
  present. Per the specification's "prepare the script element" steps a `type`
  that is neither empty, nor a JavaScript MIME type, nor `module` gives the
  element a null script type and the algorithm returns: the external script is
  never fetched. `type="application/json"`, `type="text/template"` and
  `nomodule` on a classic script do the same. Closed by proposal 16, reported as
  `TAG_NOT_EXECUTED` — the eighth `widget_reason`, which costs nothing in the
  database because the migration whitelists the key and the row schema bounds
  the value. Proposal 7 is amended, because the finding falsified it: host and
  path are not sufficient for "ours".

  Two things about this are worth keeping on the record. It was **the one error
  the module declares it must not make**, and it was **the invariant the
  contract states outright** — stated, and enforced on only one of its two
  halves. And the test suite showed the shape of the gap: eight cases in "a page
  that carries the text of an installation but renders none", every one varying
  _where_ the tag sits and none varying _whether the element runs_. A complete
  enumeration along one axis reads like thoroughness, which is what made the
  missing axis invisible. The axis is now a block of its own, with the negative
  and positive directions beside each other.

- **Note 1, four more inputs where the scanner reported a tag a browser would
  not run. All four fixed.** A `<script src>` inside `<svg>` or `<math>` (another
  namespace, where `script` takes `href`), `<script<x …>` (the tokenizer appends
  the `<` to the name, making an unknown element), `</ <script …>` (a bogus
  comment, which swallows to the first `>`), and anything after `<plaintext>`.
  Fixed in the reviewer's order: the tag-open rule first, because it is
  spec-accurate rather than a special case and closes two of the four — after
  `<`, only an ASCII letter starts a tag, and `<` then becomes legal _inside_ a
  name; after `</`, a non-letter is a bogus comment. Then a `foreignDepth`
  counter for `svg`/`math`, written the way `templateDepth` already is, because
  reading the tags is what keeps the tokenizer honest about what closes what.
  Then `plaintext`, which ends the scan. A self-closing `<svg/>` opens no
  subtree, because the solidus an HTML element ignores does close a foreign one
  — without that, one narrow false positive would have become a page-wide false
  negative.

  The reasoning this replaces is worth naming, because it was the actual defect
  behind three of the four. The module's own comment discounted its limits as
  unreachable "by a page that is merely unusual rather than deliberate". For
  this module **deliberate is the threat model**: a customer who wants the
  record to say compliant without disclosing anything is precisely who it
  exists to catch. A limit here is a cost to be paid down, not a risk to be
  discounted. The limits that remain are all in the safe direction — `svg` and
  `math` are skipped whole, so a script inside one of their HTML integration
  points is missed, which is a false negative on a page nobody serves.

- **Note 2, a `<meta charset="utf-16le">` on an ASCII page was honoured. Fixed
  on the `<meta>` path only.** The encoding standard's prescan substitutes UTF-8
  for UTF-16BE/LE and windows-1252 for `x-user-defined`; the rule exists because
  the misconfiguration is real, and honouring the declaration literally decodes
  every `<script>` into noise and records `WIDGET_NOT_FOUND` against a customer
  who complied. Scoped there deliberately: a byte order mark means the page
  really is UTF-16, and the rule is specified for the prescan rather than for a
  `Content-Type` a server sent, so applying it to all three sources would be
  wrong in the other direction.

  Fixing it surfaced two dead branches, both now honest. This Node's
  `TextDecoder` rejects `x-user-defined` outright, so the substitution has to
  happen before the decoder is built rather than after. And no label reaches the
  `replacement` encoding at all — every one of them throws — so the
  `encoding === "replacement"` guard is unreachable today, and the test that
  appeared to cover it was passing through the `catch`. The guard is kept, for a
  future runtime that does implement those labels: without it, an upgrade would
  silently start decoding such pages to U+FFFD and failing the customers who
  serve them, with nothing in the diff to explain it. The comment and the test
  now say which path actually runs.

One thing the review corrected about the review itself, recorded because the
reviewer volunteered it: on PR #40 note 4 it had asked for a catch-all and now
says the opposite — keeping the rejection was right, because a catch-all there
would have manufactured exactly the false evidence the rest of that review
argued against.

## Invariants

- No fetched byte is executed, `eval`-ed, or passed to a parser that could
  execute one. The scanner reads text and returns tag names and attributes.
- A tag that a browser would not run is not a tag that was found. Two
  independent halves: the tokenizer decides where a tag may sit, and
  `isExecutable` decides whether the element runs. The PR #41 review found this
  invariant stated and only half enforced.
- `metadata` gains keys only through a migration that names them, and every
  stored value comes from a fixed vocabulary or is a number.
- No identifier read off the customer's page is ever stored.
- The expected origin is not a parameter of anything a caller can reach.
- `DISCLOSURE_VERSION_MISMATCH` is emitted by nothing in this task, and
  `disclosure_version` is null in every row it produces.

## Acceptance criteria

- The documented installation, on a page of ordinary HTML, is found.
- The same tag inside a comment, a `<script>` body, a `<textarea>`, a
  `<noscript>` and a `<template>` is not found.
- A tag whose `src` is the customer's own host is `WIDGET_NOT_FOUND` with
  `FOREIGN_ORIGIN`.
- A tag of ours carrying another deployment's identifier is
  `DEPLOYMENT_ID_MISMATCH` with `widget_detected: true`.
- A windows-1252 page and a Shift_JIS page both decode, and the tag in them
  is found.
- Every key this task produces is accepted by the migration's constraint, and
  an unknown one is still refused.

## Required tests

- `tests/unit/verification/html-scan.test.ts` — the tokenizer, against HTML
  that is trying to lie: comments, raw text, unquoted and unterminated
  attributes, uppercase tags, a `<` inside an attribute value, an unclosed
  comment at EOF.
- `tests/unit/verification/decode-body.test.ts` — the header, the sniff, the
  default, an unknown label, a BOM.
- `tests/security/verification/verification-inspection.test.ts` — the
  mapping, every reason, and the negatives above.
- `supabase/tests/verification_checks.test.sql` — the widened whitelist.
- `tests/unit/verification/verification-check.test.ts` — the schema and the
  migration still name the same keys.
