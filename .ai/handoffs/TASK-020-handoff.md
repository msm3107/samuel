## Handoff

### Summary

One script tag renders a customer's AI transparency notice:

```html
<script
  async
  src="https://your-article50-host/widget.js"
  data-deployment="dep_7k2m4qphr6vt3wzc5nxa7jd2fb"
></script>
```

`public/widget.js` reads the identifier, calls TASK-019a's endpoint, and
renders the message as text inside an open shadow root — or renders nothing,
silently, and never breaks the page it is on.

**No migration, and nothing behind the endpoint changed.** This pull request
adds one static file, its cache header, its checks and its tests.

### Decisions

Owner, 2026-09-26. This closes **open decision 1** in `.ai/PLAN.md`, which
had blocked Phase 6.

1. **Served from the application origin**, `/widget.js`, not a CDN domain.
   One host in the customer's CSP for both `script-src` and `connect-src`,
   and the widget finds the endpoint from its own script URL, so previews
   and a future custom domain need no rebuild. Cost: README §11's
   `cdn.article50.dev` example was wrong and is corrected; moving to a CDN
   later means baking the API origin in at build time.
2. **One URL, revalidated hourly.** A fix reaches every installed site
   within the hour without anyone editing their page. Cost: a bad release
   reaches everyone as fast as a good one.
3. **The notice renders where the script tag sits**, or into `data-target`.
   The customer chooses placement; they know their layout and carry the
   duty. A script in `<head>` has no place on the page, so the widget asks
   for `data-target` rather than guessing a corner.
4. **An open shadow root with a few CSS custom properties.** The page's CSS
   cannot reach the notice and the notice's cannot reach the page, while
   colour, font and size stay themeable.

Implementer (proposed): no build step; type-checked anyway; no global; the
script finds itself and its own origin; the identifier's shape checked
before any request; `textContent`, never HTML; `adoptedStyleSheets` rather
than an inline `<style>`; `credentials: "omit"` and nothing stored; one
notice per script tag; `version` exposed as an attribute, not shown; an
evergreen browser floor; the cache header in `next.config.ts`. The contract
states each one's reason and what was rejected. All twelve accepted on the
PR #37 review. Accepted by Mikołaj Smoliniec (project owner), 2026-09-26.

On the PR #37 review (owner, 2026-09-26): the cache header now delivers the
hour it promised (note 1); Subresource Integrity is documented as
deliberately unsupported (note 2); a broken installation now says so once
instead of looking like a deployment with nothing to show (note 3); the
message carries `dir="auto"` (note 4); and the one-install-per-page
assumption is written down (note 5).

### Files changed

- `.ai/tasks/TASK-020-public-widget.md` (new): the contract
- `public/widget.js` (new): the widget
- `tsconfig.widget.json` (new), `package.json`, `eslint.config.mjs`: it is
  linted and type-checked like everything else
- `next.config.ts`: its cache header
- `README.md` §11: installation, `data-target`, theming, and the two CSP
  entries a customer needs
- `.ai/PLAN.md`: open decision 1 closed, Phase 6's blocking note replaced
  with the answer

### Security considerations

- **It renders text, never markup.** `textContent` only; the file contains
  no `innerHTML`, `outerHTML` or `insertAdjacentHTML`, and a test reads the
  shipped file to keep it that way. A browser test publishes a message
  containing `<img src=x onerror=…>` and asserts it appears as characters
  and that the handler never ran.
- **It defines no global and stores nothing.** One IIFE, nothing on
  `window`, no cookie, no `localStorage`, no `sessionStorage`, no beacon,
  no timing. A browser test asserts the page's own `widget`, `Article50` and
  `article50` survive untouched, and that no cookie or storage entry exists
  after the notice renders.
- **It loads no code but itself.** No `eval`, no `new Function`, no
  `document.write`, no dynamic `import`, no second script. Asserted against
  the shipped bytes.
- **It sends nothing about the visitor.** One `fetch`, `credentials:
"omit"`, to a URL derived from its own `src`. No `XMLHttpRequest`, no
  `navigator` read of any kind.
- **A strict `style-src` needs no exception for us.** Styles go in through
  a constructable stylesheet, which is not an inline style for the page's
  CSP; no element carries a `style` attribute. A `<style>` element is the
  fallback for browsers without `adoptedStyleSheets`, where a strict policy
  would leave the notice unstyled rather than absent.
- **Every failure renders nothing.** Missing configuration, a malformed
  identifier, a network error, a `404`, an unreadable body — and the whole
  entry point is wrapped, so nothing this script does can throw into
  somebody else's page.
- **The shape check happens in the browser too**, so a typo costs no
  request. A configuration mistake says so once in the console; a
  deployment with nothing to show says nothing, because that is a normal
  state.

### Tests

Required by the contract: all covered. 17 assertions against the shipped
file, and 12 browser tests on a real cross-origin page — three of them added
for the review's note 3, including one that asserts the ordinary empty
answer still says nothing.

### The PR #37 review

Approved with five non-blocking notes. Four changed something.

- **note 1, applied — and it was a real defect.** `/widget.js` carried
  `stale-while-revalidate=86400`, so a client could serve a copy up to 25
  hours old, while the config comment, the contract and the browser test all
  promised "within the hour". The test pinned the misunderstanding instead
  of catching it. SWR is gone: it is right for the disclosure endpoint,
  where it trades freshness of content against a burst on the database, and
  wrong here, where it would trade the speed of the fix path for executable
  code on other people's sites. The cost is one conditional request per
  client per hour, answered `304`.
- **note 2, documented.** Subresource Integrity cannot work here: it needs
  bytes that never change at a URL, which is the opposite of the
  one-URL-forever decision that makes the fix path work, and it needs
  `Access-Control-Allow-Origin` on the script, which it does not have.
  README §11 tells customers not to add it and why, because a customer who
  does loses their notice.
- **note 3, applied.** A copied `widget.js` asks the copier's own server for
  the notice and is answered by their 404 page — and heard nothing back. The
  discriminator is exact: our answer is JSON with an error code, theirs is
  HTML. The widget now says one thing, once per page load, for a `404` that
  is not ours, any other bad status, a body that is not a notice, and a
  request that never completes. The ordinary empty answer stays silent.
  Three browser tests cover it, including one that asserts the real empty
  answer still says nothing.
- **note 4, applied.** `dir="auto"` on the paragraph, as the dashboard
  already does: a message can contain right-to-left text whatever its
  declared language, and it must not read one way in the dashboard and
  another on the customer's site.
- **note 5, documented.** The `currentScript` fallback assumes one install
  per page; `document.currentScript` is always set for a classic script, so
  ordinary installs are unaffected. README §11 now asks for one classic
  script tag per deployment.

### The two stale Phase 6 lines

The review said two lines in `.ai/PLAN.md` Phase 6 were stale without naming
them. Two could be shown to be wrong, and both are corrected:

- The exit criterion said "**Built** widget is under 10 KB compressed". The
  widget is deliberately not built; it now records the measurement of the
  shipped file, 4191 bytes gzipped from 11566 bytes of source.
- The invariant said the widget "fails silently and completely", which note
  3 makes untrue on purpose. It now says what is actually guaranteed: never
  throws, never blocks rendering, always renders nothing on failure, and
  stays silent about a deployment with nothing to show — while allowing one
  console line for an installation mistake.

If the review meant two different lines, they need naming: the task list and
the rate-limiting paragraph were corrected in PR #35, and nothing else in
Phase 6 reads as stale to me.

### The sign-off list, checked again

Every TASK-010 to TASK-019a contract **and** handoff carries an
"Accepted by" marker. TASK-020's was the only one open, and this commit
writes it. The review's standing item is stale for the third time.

### Recorded: why the widget ships unbuilt

The one artifact that runs on other people's sites is hand-written,
readable JavaScript with no bundler in its path. What a customer's browser
executes is exactly what is in this repository — no build step to trust, no
committed artifact that can drift from its source, and no build-time
dependency in the path of third-party code. It is still linted, and
`tsconfig.widget.json` type-checks it against the DOM (`checkJs`), so it is
not an untyped corner of a strict codebase; `pnpm typecheck` runs both
projects.

The budget is what makes this affordable: **4191 bytes gzipped, from 11566
bytes of source** — under half the plan's 10 KB, comments included, after
the review's note 3 added the failure messages. A transparency product's
script should be readable by the person asked to embed it.

The reviewer added an argument this handoff had not made: shipping unbuilt
is what made the review possible. For every other file here a reviewer reads
intent; for this one they read the bytes that will execute on customers'
sites.

The alternative — TypeScript through esbuild into a committed artifact —
buys types at the cost of a dependency, an artifact-versus-source gap, and
a test whose only job is to close that gap again. Rejected on those terms,
not on effort.

### Recorded: two test findings that changed the tests, not the widget

Both were assertions of mine that claimed more than the product promises.

- **Chrome refused the first version of the browser test.** The customer's
  page was faked with route interception, and Chrome's Local Network Access
  check blocks a request to loopback from a page whose address space it
  cannot place: `Permission was denied for this request to access the
loopback address space`. The fix is in the harness, not the widget — the
  customer's page is now served by a real HTTP server on its own loopback
  port. Two ports are two origins, so CORS is still exercised in full.
  Disabling the browser's check would have tested a browser nobody uses.
- **A page can hide the notice, and that is deliberate.** The first test
  asserted the notice stays visible under `* { display: none !important }`.
  It does not: that rule matches the **host element**, which lives in the
  page's own DOM. Winning that fight would mean `!important` on our side,
  which would also override a customer's deliberate styling — and the
  owner's decision explicitly accepts that a customer who wants the notice
  gone can simply not install it. The test now asserts the claim the widget
  actually makes: under that same hostile CSS, nothing reaches **inside**
  the shadow root — colour, background and visibility are all ours.
  Visibility is asserted separately against the aggressive-but-ordinary CSS
  a real site has.

While fixing the second, the font size came back as 56px rather than the
14px asserted. That is correct: `0.875rem` follows the **root** font size,
which the hostile page had set to 64px. It is also the reason to keep
`rem` — a visitor who has enlarged their browser's default text gets a
larger notice, which `px` would deny them. The test now asserts the size
against the root rather than against a constant, and says why.

### Commands run

On the final state of the branch:

```
pnpm typecheck                       pass (both projects)
pnpm lint                            pass
pnpm format:check                    pass
pnpm test                            63 files, 1719 tests, pass
supabase test db --local             8 files, 290 tests, pass
vitest --config vitest.supabase.*    32 files, 400 tests, pass
pnpm test:e2e:supabase               28 tests, pass
next build                           pass
```

The database was reset to the migration head before the database suites and
again before the browser suite. `CODEX-SECURITY.md`'s sha256 was checked
before and after Prettier: unchanged.

ESLint was checked for vacuity rather than assumed: a deliberate undefined
global and an unused variable were appended to `public/widget.js`, and both
`no-undef` and `no-unused-vars` fired, so the new config block really does
reach the file. The sentinel was removed and the file re-checked.

### Before merging

- **No migration.** Supabase's "Deploy to production" has nothing to apply.
- **`pnpm typecheck` now runs two projects**, the second for the widget. CI
  runs the same script, so nothing else changes.
- **The widget is served from the application origin**, so the first
  production deploy after this merge makes `/widget.js` public. It reads
  nothing and needs no configuration.

### Remaining concerns

- **TASK-021 is next**: the installation instructions in the dashboard,
  which should generate the exact script tag for a deployment — this README
  section is the source for that text.
- **`learnMoreUrl` is owed** as a whole (column, editor field, and the
  widget's link), and the widget has no branch for it yet. That task drops
  and recreates `public.public_disclosure`, so the revoke pinned by PR
  #35's note 1 must survive.
- **Nothing purges the cache on publish** (PR #36 review): about six
  minutes is the floor on taking a wrong notice down. Now visible to
  customers through the widget rather than only through the endpoint.
- **A hard ceiling belongs at the edge** if the public endpoint's alert
  ever fires in anger (PR #36 review, note 3).
- **The key rotation** (PR #35, note 5) is still owed.
- **Owed from earlier tasks, unchanged:** stale-save protection on the AI
  system edit form; a member directory if a publisher is ever to be named.
