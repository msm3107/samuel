# TASK-020 — The public widget

## Objective

One script tag on a customer's site renders their AI transparency notice.
`widget.js` reads a public deployment identifier, calls TASK-019a's
endpoint, and renders the message as text — or renders nothing, silently,
and never breaks the page it is on.

This closes open decision 1 in `.ai/PLAN.md`.

## Owner agent

Frontend

## Dependencies

TASK-014 (`public_id` and its shape), TASK-019 (the lookup), TASK-019a (the
endpoint, its CORS policy and its cache). All merged.

## Allowed files

- public/widget.js (new: the widget itself)
- next.config.ts (its cache header only)
- eslint.config.mjs, tsconfig.widget.json (new), package.json (checking it)
- README.md (§11 installation and CSP guidance, §12)
- .ai/PLAN.md (closing open decision 1)
- tests/\*\*

## Forbidden files

- app/\*\*, features/\*\*, lib/\*\* — the endpoint is finished; the widget is a
  leaf that calls it and changes nothing behind it
- supabase/\*\* — no migration, no policy
- proxy.ts — `/widget.js` is already outside the matcher

## Decisions

Chosen by Mikołaj Smoliniec (project owner), 2026-09-26:

- **Served from the application origin**, `/widget.js`, not a CDN domain.
  One host in the customer's CSP for both `script-src` and `connect-src`,
  no new infrastructure, and the widget finds the API from its own script
  URL, so previews and a future custom domain need no rebuild. Cost: README
  §11's `cdn.article50.dev` example is wrong and is corrected here; moving
  the script to a CDN later means baking the API origin in at build time;
  and the application origin's availability is the widget's, which was
  already true of the endpoint it calls. Rejected: a separate CDN domain —
  the domain does not exist, so it would block this task on infrastructure,
  and customers would allow-list two hosts.
- **One URL, `/widget.js`, cached about an hour.** A fix reaches every
  installed site within the hour without anyone editing their page, which
  matches what the endpoint itself does: this is compliance tooling, and a
  stale notice should heal itself. Cost: the file is revalidated hourly
  rather than cached forever, and a bad release reaches everyone as fast as
  a good one. Rejected: an immutable `/widget/v1.js` (a bug fix could not
  reach installed sites at all without a mutable loader in front, which is
  the same problem one layer down) and a hash query (every customer must
  edit their page for any fix).
- **The notice renders where the script tag sits**, or into the container
  named by `data-target`. The customer chooses placement: they know their
  layout and they carry the legal duty. Cost: a script in `<head>`, or one
  loaded from a callback, has no meaningful position — the widget refuses
  to guess and asks for `data-target` in the console instead. Rejected: a
  fixed corner badge (collides with cookie banners and chat launchers, and
  is the pattern sites most often suppress) and requiring `data-target`
  always (it breaks the one-tag install).
- **An open shadow root with a few CSS custom properties.** Styles cannot
  leak in or out, so a page's existing CSS cannot break the notice, while
  colour, font and size stay themeable. Cost: a customer can style it to be
  unreadable — they could equally not install it, and they carry the duty
  either way. Rejected: a closed root with no theming (it looks foreign on
  every designed site, which is why such widgets get removed rather than
  restyled) and prefixed class names with no shadow root (the page's CSS
  can break the notice by accident, the exact failure the plan's exit
  criterion tests for).

## Proposed by the implementer

Awaiting the owner's sign-off.

1. **No build step: `public/widget.js` is hand-written, readable
   JavaScript.** What the customer's browser executes is exactly what is in
   the repository — no bundler in the path of the one artifact that runs on
   other people's sites, and no committed build output that can drift from
   its source. The compressed budget is met with room to spare, and the
   comments a reader of a transparency product's script might want cost
   almost nothing once gzipped. Rejected: TypeScript through esbuild into a
   committed artifact, which buys types at the cost of a new build-time
   dependency, an artifact-versus-source gap, and a test whose only job is
   to close that gap again.
2. **It is still type-checked.** `tsconfig.widget.json` checks the file with
   `checkJs` against the DOM library, and `pnpm typecheck` runs it, so the
   file is not an untyped corner of a strict codebase. Rejected: turning
   `allowJs` on in the main `tsconfig.json`, which would relax the setting
   for every file to check one.
3. **Nothing is added to `window`, and nothing global is read that a page
   could have replaced.** The whole file is one IIFE. Rejected: a named
   global for programmatic control, which is a name to collide with and an
   API to keep.
4. **The script finds itself, then its configuration.**
   `document.currentScript` at the top of the IIFE, falling back to the last
   `script[data-deployment]` for the module and callback cases where the
   browser sets it to null. The API origin comes from that script's own
   `src`, so nothing is hardcoded.
5. **The identifier's shape is checked in the browser before any request**,
   with the same rule the server uses. A typo costs no request, and the
   console says so once — a configuration mistake is the installer's to see,
   while an unknown or withdrawn notice is a normal state and says nothing.
6. **The message is rendered with `textContent`, never HTML.** No
   `innerHTML`, no `insertAdjacentHTML`, no template that could interpolate.
   This is the last place a stored message could become markup, and the
   whole path from the table to here is plain text by construction.
7. **Styles go in through `adoptedStyleSheets`, with a `<style>` element
   only as a fallback.** A constructable stylesheet is not an inline style
   for the page's Content Security Policy, so a customer running
   `style-src 'self'` needs no exception for us; a `<style>` element would
   need `'unsafe-inline'`. No element carries a `style` attribute either,
   for the same reason.
8. **The request is `credentials: "omit"`, and nothing is stored.** No
   cookie is read or written, no `localStorage`, no `sessionStorage`, no
   beacon, no timing, nothing about the visitor leaves their browser.
   Failure of any kind renders nothing at all.
9. **One notice per script tag, rendered once.** The script element is
   marked when it has rendered, so a hot reload or a double execution of the
   same tag cannot duplicate the notice; two script tags are two notices,
   which is the customer's choice.
10. **`version` is not displayed, but is exposed as `data-version` on the
    host element**, so a page — or an auditor's script — can read which
    version was live without the notice growing a number nobody asked to
    see. That is the citability argument from TASK-019's note 3, made
    concrete.
11. **The browser floor is evergreen.** `fetch`, `attachShadow` and
    optional chaining are used without polyfills; `adoptedStyleSheets` has
    the fallback above. An older browser renders nothing and throws nothing,
    which is the same as every other failure. Rejected: polyfills, which
    cost more than the notice weighs.
12. **The cache header lives in `next.config.ts`**, beside the security
    headers: `public, max-age=3600, stale-while-revalidate=86400`. Next
    serves `public/` with no useful caching otherwise, and the widget is the
    one static file whose staleness anyone will feel.

## Invariants

- **The widget never throws into the customer's page.** Every path —
  missing configuration, a malformed identifier, a network failure, a `404`,
  an unreadable body — ends in rendering nothing.
- **It defines no global and overwrites nothing.**
- **It stores nothing**: no cookie, no web storage, no analytics.
- **The message reaches the page as text**, never as markup.
- **The page's CSS cannot change the notice, and the notice's CSS cannot
  change the page.**
- **It loads no code but itself**: no second script, no `eval`, no
  `new Function`, no `document.write`.

## Acceptance criteria

- One script tag with `data-deployment` renders the current notice on a
  cross-origin page.
- A page that already defines conflicting global names and hostile CSS
  renders the notice correctly, and its own globals are untouched.
- An unknown, withdrawn or archived deployment renders nothing, with no
  error in the console and no exception in the page.
- A malformed `data-deployment` makes no request.
- The built file is under 10 KB compressed, measured and recorded.
- No cookie and no storage entry is created by loading the widget.

## Required tests

- Static: the shipped file contains no `eval`, `new Function`,
  `document.write`, `innerHTML`, `document.cookie`, `localStorage` or
  `sessionStorage`; its gzipped size is under 10 KB and the measurement is
  recorded.
- Browser, cross-origin, against the real endpoint: the notice renders; a
  hostile page (conflicting globals, `* { display: none !important }`)
  still renders it and keeps its own globals; a withdrawn notice renders
  nothing silently; a malformed identifier makes no request; a message
  containing markup appears as text; no cookie or storage is written.
- Browser: a script in `<head>` with no `data-target` renders nothing and
  says why once.
