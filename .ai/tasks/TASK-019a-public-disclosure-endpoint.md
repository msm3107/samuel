# TASK-019a — Public disclosure endpoint

## Objective

The one HTTP surface the whole internet may call: turn a public deployment
identifier into the notice that deployment should show, by calling
`public.public_disclosure` (TASK-019, merged in PR #35). Rate limited,
cached publicly, readable cross-origin, and returning three fields and
nothing else.

This is the second half of Phase 6's TASK-019. The function it calls is
already in the schema, so this pull request adds **no migration**.

## Owner agent

Backend

## Dependencies

TASK-003c (`lib/security/rate-limit.ts`, `consume_rate_limit`), TASK-007
(`lib/http/api.ts`, the error format), TASK-014 (`public_id`,
`isPublicDeploymentId`), TASK-019 (`public.public_disclosure`). All merged.

## Allowed files

- app/api/public/\*\* (the new route)
- lib/http/public-api.ts (its response helper)
- lib/database/public-client.ts (the anon client, no session)
- features/disclosures/public-disclosure\*.ts
- lib/security/rate-limit.ts (new `RATE_LIMITS` entries only)
- proxy.ts (the matcher exclusion only)
- README.md (§11)
- tests/\*\*

## Forbidden files

- supabase/\*\* — this task adds no migration and changes no policy
- lib/http/api.ts — the dashboard's `jsonResponse` keeps `private, no-store`
- lib/database/service-role-client.ts, lib/database/session-client.ts
- every other route handler

## Decisions

Chosen by Mikołaj Smoliniec (project owner), 2026-09-26:

- **`GET /api/public/disclosure/{publicId}`.** The identifier is a path
  segment, so every cache keys on it cleanly and no intermediary can drop or
  reorder a query string; the path names what comes back rather than a
  vaguer "config". Cost: a second public field that is not part of the
  notice would need its own endpoint or a rename, and customers put this URL
  in their `connect-src`, so it is effectively permanent. Rejected:
  `/api/public/config/{id}` (README §11's wording, but vague for something
  that returns exactly a disclosure) and `?deployment={id}` (query strings
  are the part caches treat least consistently).
- **Nothing to show is `404` with a code-only body**, `{"error":{"code":
"disclosure_not_found"}}`, cached exactly like a hit. HTTP says plainly
  there is nothing here, the widget needs no body inspection to know it, and
  an enumeration attempt is absorbed by the shared cache. All six causes
  stay indistinguishable (TASK-019's third decision). Cost: it departs from
  the dashboard API's error shape, which always carries a reference code —
  here the 404 is an expected outcome rather than a fault, and a reference
  per unknown identifier would mean a log line per unknown identifier, which
  hands the public this application's log volume. Rejected: `200` with a
  null payload (a success status for something that does not exist, and it
  breaks README §11's flat body), and the standard error body (consistent,
  but the public decides how much we log).
- **The service-wide limit alerts and never refuses.** A ceiling that
  refused would take every customer's notice off every customer's site at
  once, decided by whoever is making the noise. The per-network limit and
  the 60-second shared cache are the defence; the service-wide counter's job
  is to tell us. Cost: no hard stop, so a wide enough botnet can push origin
  load up to whatever the database will bear. Rejected: refusing as sign-in
  does (`magicLinkGlobal`), and no service-wide counter at all.
- **A stale copy may be served for up to 5 minutes while a fresh one is
  fetched** (`s-maxage=60, stale-while-revalidate=300`). On a busy site the
  refresh happens behind the visitor; on a quiet one, one visitor may see a
  copy about six minutes old. Which way that errs matters: a withdrawn
  notice lingering means showing a transparency notice the customer no
  longer claims, while a newly published one is delayed by the same window —
  the second is the one that carries legal weight, and six minutes is well
  inside any reading of "promptly". Rejected: a strict 60 seconds (every
  expiry makes some visitor wait on the database, and bursts arrive at the
  origin together).

## Proposed by the implementer

All twelve accepted on the PR #36 review. Accepted by Mikołaj Smoliniec
(project owner), 2026-09-26.

1. **The shape check comes first, and a malformed identifier is refused
   with a `400`** whose code is `invalid_deployment_id` (PR #35 review,
   note 4). `isPublicDeploymentId` accepts only `dep_` and 26 lowercase
   base32 characters, so a wrong-cased
   or truncated identifier is refused at the boundary rather than falling
   through to the same empty answer a withdrawn notice gives. Refusing on
   shape is no oracle: the shape is public knowledge and says nothing about
   which deployments exist. It also makes junk the cheapest thing this
   endpoint does — a regex, no limiter call, no query.
2. **The rate limit is spent after the shape check and before the lookup.**
   The limiter exists to protect the database; a request that cannot reach
   the database needs no permission from it. Rejected: limiting first, which
   would make every malformed request cost a database write.
3. **Two new limits, plus an alert bucket.**
   `publicDisclosureNetwork` (300 per 5 minutes) refuses with `429`.
   `publicDisclosureGlobal` (20000 per 5 minutes) refuses nothing: when it
   is exhausted the request is still served and
   `publicDisclosureCeilingAlert` (1 per 5 minutes) bounds the log to one
   entry per window, exactly as `magicLinkGlobal` and
   `magicLinkThresholdAlert` do. Cost, stated plainly: a request that
   reaches the database costs two limiter round trips, and one that passes
   an exhausted service-wide counter costs three. The 60-second shared cache
   is what makes that affordable — the origin sees roughly one request per
   identifier per minute per region, not one per page view.
4. **A limiter that cannot answer refuses the request (`503`).** The
   standing rule — a limit that disappears when the database is slow
   protects nothing — and here it costs nothing extra: the limiter and the
   lookup are the same database, so a limiter outage is an outage of the
   answer too. The service-wide counter is the exception: it is alert-only,
   so when _it_ cannot answer the request is served and the failure logged.
5. **A dedicated anon client, `createPublicClient()`, that reads no
   cookies.** Not the session client: reading cookies would make the
   response depend on the visitor, and a shared cache would then serve one
   visitor's answer to another. Not the service-role client: the rule is
   that it never serves a request another client could serve, and this is
   the request where a query-construction mistake would be a cross-tenant
   leak. It holds the anon key, whose whole reach in this schema is the one
   function TASK-019 granted it.
6. **The database's answer is validated with Zod before it is sent.** The
   RPC is external input like any other: an array of at most one row, three
   keys, `version` a positive integer, `language` and `message` non-empty
   strings. A row that does not match is a `500` with a reference, never a
   forwarded body — which is what makes "no key beyond the documented ones"
   true of the wire, not only of the SQL.
7. **`lib/http/public-api.ts` is a separate module from `lib/http/api.ts`.**
   The dashboard's `jsonResponse` hardcodes `private, no-store` and must
   keep doing so; rather than parameterise it, the one cacheable,
   cross-origin response builder in the application is its own module, so
   `grep` finds every public response in one place. Rejected: adding a
   `cache` option to `jsonResponse`, which would put a `public` cache one
   wrong argument away from every dashboard route.
8. **Only `200`, `404` and `400` are cacheable. `429`, `503` and `500` are
   `private, no-store`.** A cached `429` would hand one caller's refusal to
   everyone behind the same shared cache; a cached `503` would outlive the
   outage. The three cacheable answers are pure functions of the URL, so one
   policy covers them all.
9. **`Access-Control-Allow-Origin: *`, with no `Vary`, no credentials and no
   `OPTIONS` handler.** Reflecting a registered hostname instead would vary
   the cache by origin, destroying most of its value, and would turn the
   endpoint into an oracle for which hostnames are registered — while
   stopping nobody, because anyone can call it without a browser. The
   widget's request is a CORS-simple `GET`, so no preflight is made and no
   `OPTIONS` route is needed; the plan already calls this a deliberate
   exception, and it is not authorization.
10. **The proxy stops running on `/api/public/`.** It exists to refresh
    sessions and stamp HTML security headers; on this route it would create
    a session client on every request — which makes auth-js refresh in the
    background and spends `sessionRefreshNetwork` buckets — on a surface
    with no session at all. The exclusion is anchored, so `/api/publications`
    keeps its headers, and the route sets `X-Content-Type-Options: nosniff`
    itself so nothing is lost by it.
11. **Nothing a caller can provoke is logged, and nothing is audited.**
    `400`, `404` and `429` write no entry: they are answers, not faults, and
    past a network's limit every further request would write a line — which
    would hand the caller this application's log volume, the same reason the
    `404` carries no reference. The service-wide alert (one entry per
    window) is the signal that something is happening, and a `5xx` logs
    because it is ours. A public read is also never audited (TASK-019's
    proposal 8): an audit row per page view of every customer site would be
    a denial-of-service surface. Cost: one network being throttled is
    invisible until the service-wide counter notices.
12. **README §11 is corrected rather than emptied.** `learnMoreUrl` leaves
    the example response and stays documented as planned-and-not-returned,
    so the requirement is not lost with the key; the stale identifier
    examples (`dep_public_xxxxx`) become the real format; and the endpoint's
    URL, its `404`, its cache and its CORS policy are written down for the
    people who have to install it.

## Invariants

- **The response body has exactly three keys**: `version`, `language`,
  `message`. No identifier, organization, system, hostname, timestamp or
  author, and no key beyond the documented ones.
- **Six causes, one answer.** Unknown, archived deployment, archived system,
  deleted organization, never published, withdrawn — one `404`, one body.
- **The route reads no cookies and no session.** It never constructs the
  session client or the service-role client for the lookup.
- **No response that depends on a caller is cacheable.** `429`, `503` and
  `500` carry `private, no-store`.
- **The dashboard's `jsonResponse` still sends `private, no-store`.** This
  task adds a public response builder; it does not widen the private one.
- **The proxy still runs on every path but `/api/public/` and the ones it
  already excluded.**

## Acceptance criteria

- `GET /api/public/disclosure/{id}` returns `200` and
  `{"version","language","message"}` for an active deployment of an active
  system whose current version is enabled.
- The same request for an unknown, archived, withdrawn or never-published
  deployment returns `404` and `{"error":{"code":"disclosure_not_found"}}`.
- A wrong-cased, truncated or otherwise malformed identifier returns `400`
  and `{"error":{"code":"invalid_deployment_id"}}` without touching the
  database.
- Past `publicDisclosureNetwork`, the answer is `429` with `private,
no-store`; past `publicDisclosureGlobal`, the answer is still the notice.
- `200`, `404` and `400` carry `Cache-Control: public, max-age=0,
s-maxage=60, stale-while-revalidate=300` and
  `Access-Control-Allow-Origin: *`.
- The header survives a production build, not only a unit test.
- README §11 documents the endpoint that exists.

## Required tests

- Unit: the response schema — a good row; a row with an extra key, a missing
  key, a wrong type, a zero version; two rows.
- Route (mocked): each of `200`, `404`, `400`, `429`, `503`; the exact
  header set on each; that a malformed identifier reaches neither the
  limiter nor the database; that an exhausted service-wide counter still
  serves the notice and logs once; that a malformed database answer is a
  `500` and never reaches the client; that no `Set-Cookie` and no `Vary` is
  sent.
- Integration (real database, through the real route handler): publish, read
  it back through the endpoint, withdraw it, read the `404`; an archived
  deployment; an unknown identifier. The anon key's whole path, as the
  widget will use it.
- Proxy matcher: `/api/public/disclosure/…` is excluded; `/api/publications`
  and `/api/organizations/…` are not.
- End-to-end (production build): the cache, CORS and `nosniff` headers
  survive the framework, and no dashboard CSP is stamped on the response.

## Amendment: the PR #36 review

Accepted by Mikołaj Smoliniec (project owner), 2026-09-26. Five
non-blocking notes; three changed the code, one is recorded here, one was
settled.

- **Note 1, HSTS. Applied.** `proxy.ts` was the only place that set
  `Strict-Transport-Security`, so excluding `/api/public/` from the matcher
  dropped it from this route alone — and this is the route most likely to
  be a third-party browser's first contact with the host, which makes it
  the worst one to omit. The handoff had reasoned about the missing CSP and
  not about this. It now lives in `next.config.ts`, which applies it to
  every path the framework serves, with the value in `lib/http/hsts.ts` so
  the two places that apply it cannot drift. `proxy.ts` keeps applying it,
  deliberately: the proxy returns the sign-in redirect and the
  session-unavailable `503` itself, and those do not pass through the
  framework's header pipeline. Rejected: moving it out of the proxy
  entirely, which would have risked exactly that.
- **Note 2, the third bucket write at peak. Applied.** Past the service-wide
  ceiling, the alert bucket was consulted on every request, so the
  per-request database cost rose from two writes to three at the busiest
  moment — the opposite of what an alert should cost. A process now asks at
  most once per window (`lib/logging/once-per-window.ts`), and the bucket
  still decides whether the entry is written. The bound is per process, so
  during an incident it is one attempt per window per instance; that is the
  more useful signal anyway, and the global bucket keeps the log itself to
  one entry. Rejected: sampling, which delays the first alert by chance.
- **Note 3, a hard ceiling belongs at the edge, recorded.** The limiter is
  itself database load, so under the flood it exists for it bends the wrong
  way: every origin-reaching request pays two bucket writes before the
  lookup, a refused one still pays one, and a `429` is `no-store` so a
  limited network keeps arriving at full rate and keeps paying. Against the
  distributed case this task deliberately accepts, the per-network limit
  never fires at all. **So when the service-wide alert fires in anger, the
  answer is a rate rule at the edge — Vercel's firewall, which costs the
  origin nothing — and not another entry in `RATE_LIMITS`.** This is the
  reason the alert-only decision is right, not an argument against it.
- **Note 4, a `503` flood decides the logging bill. Applied.** When the
  database is out the limiter is out too, so every request became a `503`
  with its own log entry, and `503` is `no-store` so nothing absorbed the
  repeats — the same problem the `404` and `429` paths deliberately avoid.
  Faults are now logged once per code per minute per process. Per code, so
  an unreadable row during an outage is not swallowed by the outage's entry.
  Cost, stated rather than hidden: a suppressed fault's reference finds no
  entry of its own, so the entry that is written carries
  `boundedForSeconds` to say it stands for the others.
- **Note 5, `version` stays**, now as a deliberate decision rather than by
  publication (owner, 2026-09-26). It is in README §11 and the plan's
  invariant, so it is a contract customers will build against and, like the
  URL, effectively permanent. The reason is TASK-019's and has not changed:
  this product exists to make a notice citable, and an auditor who records
  "version 7 was live on this date" has evidence where the text alone may
  since have changed. It also gives TASK-020 a natural cache key. Cost,
  accepted: anyone holding a public identifier learns how often that notice
  has been revised.

The review also confirmed that the limiter keys on a header a client cannot
forge, that IPv6 is bucketed by /64, that the cache policy is decided per
status, that the anon client cannot acquire a session, that the strict
response schema turns the future `learn_more_url` return-type change into a
loud failure rather than a quiet new key, and that no `OPTIONS` handler is
correct rather than an omission — a `GET` with no custom request headers
never preflights.

### Out of contract

Recorded under the owner's standing permission to edit outside the Allowed
files (2026-09-24), all from the review above:

- `next.config.ts` and `lib/http/hsts.ts` (new): note 1's HSTS header and
  the constant behind it.
- `proxy.ts` beyond the matcher: it now reads that constant instead of
  holding its own copy.
- `lib/logging/once-per-window.ts` (new) and `tests/unit/logging/`: the
  per-process budget behind notes 2 and 4.
- `.ai/PLAN.md`: Phase 6 records that nothing purges the cache on publish,
  so about six minutes is the floor on withdrawing a notice, and names the
  fix as a purge in the publish path rather than a shorter header.
