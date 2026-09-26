## Handoff

### Summary

Phase 6's second half. `GET /api/public/disclosure/{publicId}` is the one
HTTP request the whole internet may make: it calls TASK-019's
`public.public_disclosure` with the anon key and no session, and answers
with the notice that deployment should show.

```
GET /api/public/disclosure/dep_7k2m4qphr6vt3wzc5nxa7jd2fb

200 {"version":3,"language":"en","message":"You are interacting with an AI system."}
404 {"error":{"code":"disclosure_not_found"}}
400 {"error":{"code":"invalid_deployment_id"}}

Cache-Control: public, max-age=0, s-maxage=60, stale-while-revalidate=300
Access-Control-Allow-Origin: *
```

**This pull request contains no migration.** The function it calls merged
in PR #35; nothing in the schema changes here.

### Decisions

Owner, 2026-09-26:

1. **`/api/public/disclosure/{publicId}`**, the identifier as a path
   segment: caches key on it cleanly and no intermediary can drop or
   reorder a query string. Customers put this in their `connect-src`, so it
   is effectively permanent.
2. **Nothing to show is `404` with a code-only body**, cached exactly like a
   hit. All six causes stay indistinguishable. No reference code, because a
   reference per unknown identifier means a log line per unknown
   identifier — the public would decide our log volume.
3. **The service-wide limit alerts and never refuses.** A ceiling that
   refused would take every customer's notice off every customer's site at
   once, decided by whoever is making the noise.
4. **A stale copy may be served for up to five minutes** while a fresh one
   is fetched. Which way that errs was weighed: a lingering withdrawn
   notice means showing a notice the customer no longer claims, while a new
   one is delayed by the same window — the second is the one with legal
   weight, and about six minutes is well inside "promptly".

Implementer (proposed): the shape check before anything else, refusing a
malformed identifier with `400`; the rate limit spent after it and before
the lookup; two new limits plus an alert bucket; a limiter that cannot
answer refuses; a dedicated anon client that reads no cookies; the
database's answer validated with Zod before it is sent; a separate
`lib/http/public-api.ts` so the dashboard's `jsonResponse` keeps
`private, no-store`; only `200`, `404` and `400` cacheable; CORS `*` with no
`Vary` and no `OPTIONS`; the proxy excluded from `/api/public/`; nothing a
caller can provoke logged; README §11 corrected rather than emptied. The
contract states each one's reason and what was rejected. All twelve accepted
on the PR #36 review. Accepted by Mikołaj Smoliniec (project owner),
2026-09-26.

On the PR #36 review (owner, 2026-09-26): HSTS moved into
`next.config.ts`, because excluding this route from the proxy had dropped it
here alone (note 1); the ceiling alert no longer spends a bucket write per
request at peak (note 2); faults are logged once per code per minute
(note 4); the edge, not `RATE_LIMITS`, is where a hard ceiling belongs when
the alert fires in anger (note 3); and `version` stays by decision rather
than by publication (note 5).

### Files changed

- `.ai/tasks/TASK-019a-public-disclosure-endpoint.md` (new): the contract
- `app/api/public/disclosure/[publicId]/route.ts` (new): the endpoint
- `lib/http/public-api.ts` (new): the public response builder
- `lib/database/public-client.ts` (new): the anon client, no cookies
- `features/disclosures/public-disclosure.ts` (new): the response schema
- `features/disclosures/public-disclosure-queries.ts` (new): the lookup
- `lib/security/rate-limit.ts`: three new `RATE_LIMITS` entries
- `proxy.ts`: `/api/public/` excluded from the matcher
- `README.md` §11: the endpoint as it exists; `learnMoreUrl` marked planned
- `.ai/PLAN.md`: Phase 6's invariant and exit criterion corrected to three
  fields, and the cache-purge limit recorded
- `next.config.ts`, `lib/http/hsts.ts` (new), `proxy.ts`: HSTS applies to
  every path, from one constant (PR #36 review, note 1)
- `lib/logging/once-per-window.ts` (new): the per-process budget behind
  notes 2 and 4

### Security considerations

- **No session, no cookie, no service-role client.** The answer depends on
  the URL alone, which is what makes it safe to put in a shared cache. The
  route uses `createPublicClient()`: the anon key, whose whole reach in this
  schema is the one function TASK-019 granted it.
- **The proxy no longer runs here.** On this route it would build a session
  client per request — which makes auth-js refresh in the background and
  spends `sessionRefreshNetwork` buckets — on a surface with no session, and
  would make the response depend on cookies a shared cache must never see.
  The exclusion is anchored, and a matcher test holds `/api/publications` on
  the other side of the line.
- **Only answers that are a pure function of the URL are cacheable.** `429`,
  `503` and `500` carry `private, no-store`: a cached refusal would be
  handed to everyone behind the same shared cache, and a cached `503` would
  outlive its outage.
- **Three keys, validated before they are sent.** The RPC's answer is parsed
  strictly, so a column added to the function's return type is a `500` here
  rather than a new field on a public endpoint. Two rows are refused rather
  than one being picked.
- **A malformed identifier is refused before the limiter and the
  database.** It is also the answer to PR #35's note 4: a wrong-cased
  identifier now fails legibly instead of looking like a deployment with
  nothing to show. The shape is public knowledge, so refusing on it is no
  oracle.
- **Nothing a caller can provoke writes a log entry.** `400`, `404` and
  `429` log nothing. Past a network's limit, a line per request would hand
  the caller our log volume — the same reason the `404` carries no
  reference. The service-wide alert, one entry per window, is the signal.
- **Six causes, one answer**, unchanged from TASK-019: the endpoint cannot
  be used to discover which deployments exist or what state a customer's
  account is in.
- **CORS `*` is deliberate and is not authorization.** Reflecting a
  registered hostname would vary the cache by origin and make the endpoint
  an oracle for which hostnames are registered, while stopping nobody —
  anyone can call this without a browser.

### Tests

Required by the contract: all covered. 48 new stubbed tests (16 schema, 27
route, 5 for the window budget), 6 real-database tests through the real
handler, 4 browser tests against a production build, and 5 added to the
matcher and rate-limit suites.

### Recorded: what the production build proved, and corrected

The end-to-end spec exists because two of this endpoint's claims are the
framework's to keep, not the handler's, and calling the handler directly
cannot check either. Both were worth running:

- **The cache header survives.** Next.js serves a dynamic route handler that
  sets no policy as `private, no-cache, no-store`; the route's own
  `Cache-Control` is what ships. Now asserted against the built app.
- **Two assumptions were wrong, and the spec caught them.** Next.js adds a
  `Vary` of its own (`rsc, next-router-state-tree, …`) after the handler
  returns, so "no `Vary`" is true of the route and not of the response. What
  matters is what it does not name: the assertion is now that it names
  neither `cookie` nor `origin`, so no cached answer can depend on a visitor
  and the cache is not split per site. And `next.config.ts` already applies
  `Referrer-Policy`, `Permissions-Policy` and `nosniff` to every path, this
  one included — so excluding the proxy costs none of them, and the missing
  CSP is the evidence the exclusion holds. The route sets `nosniff` itself
  as well, so its guarantee does not rest on a configuration file that could
  be narrowed for another reason.

### The PR #36 review

Approved with five non-blocking notes. Three changed the code.

- **note 1, applied:** `proxy.ts` was the only place setting HSTS, so
  excluding `/api/public/` dropped it from this route alone — the route
  most likely to be a third-party browser's first contact with the host,
  and so the worst one to omit. The end-to-end spec had reasoned about the
  missing CSP and not about this. HSTS now comes from `next.config.ts`,
  which no matcher can narrow, with the value in `lib/http/hsts.ts`;
  `proxy.ts` keeps applying it, because the sign-in redirect and the
  session-unavailable `503` are the proxy's own responses and never reach
  the framework's header pipeline.
- **note 2, applied:** past the ceiling, the alert bucket was consulted on
  every request, so the per-request database cost rose from two writes to
  three exactly when the service was busiest. A process now asks once per
  window; the bucket still decides whether the entry is written.
- **note 3, recorded, nothing to change:** the limiter is itself database
  load, so under a distributed flood it bends the wrong way — which is the
  reason the alert-only ceiling is right, and the reason the answer to that
  alert is a rate rule at the edge rather than another `RATE_LIMITS` entry.
  Written into the contract so the next person finds it.
- **note 4, applied:** a database outage made every request a `503` with its
  own log entry, and `503` is `no-store`, so nothing absorbed the repeats.
  Faults are logged once per code per minute per process. A suppressed
  fault's reference finds no entry of its own; the one that is written says
  so with `boundedForSeconds`.
- **note 5, settled:** `version` stays, now by decision rather than by
  publication. See the contract.

### Recorded: the HSTS assertion was checked for vacuity

Added to the end-to-end spec and then checked the way PR #35's revoke
assertion was: with the `next.config.ts` entry removed, the built app
answered the public route with no `strict-transport-security` at all
(`Received: undefined`) and the assertion failed; restored, it passes. So
the header really was missing before this change, and the test fails where
it is meant to.

### Two stale items, corrected

The review's last two open items were already done and are not owed:

- **`.ai/PLAN.md` Phase 6** already names TASK-019 and TASK-019a, and
  already says rate limiting landed in Phase 1 (TASK-003c). Both were
  corrected in PR #35 (`5f74527`).
- **The TASK-010 to TASK-019 sign-offs** are all present, in every contract
  and every handoff. `TASK-015-handoff.md` and `TASK-018a-handoff.md` look
  empty to a search for the whole name only because it wraps across a line
  break. TASK-019a's marker is the one that was open, and this commit
  writes it.

### Recorded: the cost of the limiter on this surface

A request that reaches the database spends two limiter round trips (network,
then the service-wide counter), and one that passes an exhausted counter
spends three. That is affordable only because of the 60-second shared
cache: the origin sees roughly one request per deployment per minute per
region, not one per page view. If the cache is ever shortened or removed,
this is the number to revisit.

### Commands run

On the final state of the branch:

```
pnpm typecheck                       pass
pnpm lint                            pass
pnpm format:check                    pass
pnpm test                            62 files, 1702 tests, pass
supabase test db --local             8 files, 290 tests, pass
vitest --config vitest.supabase.*    32 files, 400 tests, pass
pnpm test:e2e:supabase               16 tests, pass
next build                           pass
```

The database was reset to the migration head before the database suites and
again before the browser suite. `CODEX-SECURITY.md`'s sha256 was checked
before and after Prettier: unchanged. Prettier was run on the five files it
named, never across the tree.

### Before merging

- **This pull request has no migration.** Supabase's "Deploy to production"
  has nothing to apply. The function this route calls shipped in PR #35 and
  is already in production.
- **`NEXT_PUBLIC_APP_URL` is not used by this route**, so a preview
  deployment serves it without further configuration.

### Remaining concerns

- **`learnMoreUrl` is owed** as a whole: a column, an editor field and the
  widget's link, in one later task. README §11 and `.ai/PLAN.md` now say it
  is planned rather than returned, so the requirement is not lost with the
  key. That task drops and recreates `public.public_disclosure` (a changed
  return type cannot be replaced), and the revoke from `public` must not be
  forgotten — which PR #35's note 1 now pins with a test.
- **TASK-020 is next**: `widget.js`, and with it the open decision about
  where it is served from — the application origin or a CDN domain — which
  changes the CSP a customer needs.
- **The endpoint's paging rule for external callers** is still only in
  TASK-018a's file (PR #34, note 3). Not this endpoint's concern, but the
  same omission.
- **A percent-encoded spelling of a valid identifier reaches the same
  deployment under a different cache key.** Deliberately not refused: an
  attacker can already mint unlimited distinct URLs with invalid
  identifiers, and both are bounded by the same per-network limit, so a
  canonical-spelling check would be code defending something the limiter
  already bounds.
- **A hard ceiling belongs at the edge.** If the service-wide alert ever
  fires in anger, the answer is a rate rule in front of the origin, not
  another `RATE_LIMITS` entry: the limiter is itself database load, so
  against the distributed flood it bends the wrong way (PR #36 review,
  note 3).
- **Nothing purges the cache on publish**, so about six minutes is the floor
  on how fast a customer can take a wrong notice down, not just the typical
  delay. Recorded in `.ai/PLAN.md` Phase 6 as a known limit to settle once
  the widget exists; the fix is a purge in the publish path, not a shorter
  header.
- **The key rotation** (PR #35, note 5) is now more concrete still: a leaked
  anon key reaches `public_disclosure` directly against PostgREST, outside
  this route's rate limit and cache.
- **Owed from earlier tasks, unchanged:** stale-save protection on the AI
  system edit form; a member directory if a publisher is ever to be named.
