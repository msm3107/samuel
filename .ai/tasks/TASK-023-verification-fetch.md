# TASK-023 — The SSRF-hardened fetch

## Objective

Fetch a deployment's home page safely: the transport, its four bounds, and
redirect revalidation, with every refusal and every exceeded bound mapping to
its own README §19 code. TASK-012 already decides whether a hostname may be
fetched at all; this task is the fetch itself.

It also pays PR #39 note 4: `metadata`'s key whitelist, as a check
constraint, now that the fetch's own vocabulary is known.

Nothing calls it yet. TASK-024 inspects the body it returns, TASK-025
schedules the call and writes the row.

## Owner agent

Security

## Dependencies

TASK-012 (`validateVerificationTarget`, `isPublicAddress`,
`normalizeHostname`), TASK-022 (`verification_checks`, its failure codes and
its `metadata` column). Both merged.

## Allowed files

- lib/security/verification-target.ts (redirect revalidation)
- lib/security/verification-lookup.ts (new)
- features/verification/\*\* (the fetch, and `metadata`'s shape)
- supabase/migrations/\*\* (one new migration: the `metadata` key whitelist)
- supabase/tests/\*\* (its assertions)
- README.md (§17's settled bounds, §19's mapping)
- .ai/PLAN.md (Phase 7)
- tests/\*\*

## Forbidden files

- app/\*\*, components/\*\* — nothing calls the fetch yet, and no screen shows
  a verification result until Phase 8
- lib/security/verification-target.ts's existing exports — extended, never
  reinterpreted: `VERIFICATION_TARGET_FAILURES` is a registration
  vocabulary with a user-facing message per code
  (`features/deployments/deployment.ts`), and a redirect-only reason has no
  place in it
- every existing migration, including TASK-022's — the whitelist is an
  additive constraint
- public/widget.js, proxy.ts, next.config.ts

## Decisions

Chosen by Mikołaj Smoliniec (project owner), 2026-09-27:

- **HTTPS first, then plain HTTP once.** The verifier tries `https://`. If
  the connection or the TLS handshake fails, it tries `http://` once, and
  the row records which scheme answered and whether HTTPS was tried and
  failed. Why: a deployment is stored as a bare name (TASK-011) with no
  scheme, README §17 allows both, and a customer served over plain HTTP has
  the same disclosure obligation as everyone else — refusing to look would
  record a failure that is really about their certificate. Cost, accepted:
  the two attempts share one total-timeout budget, and evidence fetched over
  plain HTTP is weaker, because a network attacker could have written the
  page we saw — so the scheme is part of the record rather than an
  implementation detail. Rejected: HTTPS only (a plain-HTTP customer gets a
  permanent failure under a code that misstates the cause; §19 has no
  `NO_TLS`) and storing the scheme on the deployment (a migration, an editor
  field and a backfill inside a task scoped to the fetch).
- **The bounds: 5s to connect, 15s in total, 1 MiB of body, 5 redirects.**
  Why 1 MiB: it clears the HTML of nearly every real site, so
  `RESPONSE_TOO_LARGE` stays a real finding rather than a routine false
  failure on a heavy page. Why 5 hops: apex → www → locale chains exist.
  Cost, accepted: a deliberately slow site can hold a worker for 15 seconds,
  and TASK-025 sizes its batches knowing that. Rejected: 256 KiB (under the
  HTML size of many marketing sites, so honest customers would collect
  `RESPONSE_TOO_LARGE` forever and the code would stop meaning what it says)
  and 30s / 2 MiB (the job's runtime is the total timeout times the
  deployment count, and both bounds exist to cap what one hostile target can
  cost).
- **A redirect may go to any public host, but never from HTTPS to HTTP.**
  Every hop is revalidated as if it were the original target. Cross-host
  hops are normal — apex to www, a CDN, a country site — so they are
  followed once the target passes the same address and reserved-name checks.
  A hop from `https:` to `http:` is refused. Why: a downgrade mid-chain is
  never required by an honest site, and it is exactly the step that turns a
  checked page into one an attacker on the path can write. Cost, accepted: a
  customer whose www redirect is misconfigured as plain HTTP fails, under a
  code that points at the redirect rather than at their certificate.
  Rejected: allowing the downgrade (evidence that began on an authenticated
  channel could silently end on an unauthenticated one) and same-registrable-
  domain only (it breaks honest setups, and "registrable domain" needs a
  public-suffix list, which is a dependency and a data file that goes stale).
- **The `metadata` key whitelist lands here, and TASK-024 adds its keys.**
  A check constraint names the keys the fetch produces; TASK-024 adds the
  inspection keys in its own migration. Why: the protection exists a task
  earlier, and widening a whitelist by a named migration is a deliberate act
  rather than drift — the same way a failure code is added. Cost, accepted:
  two migrations against the constraint before anything has ever written a
  row, which is the churn that argued for deferring it in the first place.
  Rejected: waiting for TASK-024 (a second deferral of the same note, and
  the promise stays a code-review promise for one more task) and bounding
  size and depth instead of keys (it does not answer the note — a page
  excerpt under 2048 bytes still fits, and stopping page content is the
  whole point).

## Proposed by the implementer

Awaiting sign-off.

1. **`node:http` and `node:https` directly, not `fetch`.** All four bounds
   have to be separable — a connection that never opened is a different fact
   from one that opened and never finished — and the resolved address has to
   be the address connected to. `fetch` exposes one `AbortSignal` and no
   seam for either. Rejected: adding `undici` to get a dispatcher with a
   `connect` option (§56: a dependency for something Node already has) and
   one `AbortSignal` for everything (`CONNECTION_TIMEOUT` and
   `TOTAL_TIMEOUT` would become the same code, against Phase 7's own rule).
2. **DNS is resolved once, by a guarded `lookup`, and that is the only way
   an address reaches the socket.** `lib/security/verification-lookup.ts`
   resolves the name, drops every address `isPublicAddress` refuses, and
   hands back one. Node's socket connects to exactly what the lookup
   returned, so there is no window between validating an address and
   connecting to it — which is what DNS rebinding needs. Rejected:
   resolving, validating, then connecting to the IP literal with a `Host`
   header (it breaks SNI and certificate validation unless every spelling is
   set by hand, and getting that wrong fails open) and validating after
   connection (the connection is the harm).
3. **Happy Eyeballs is turned off and one address is used.**
   `autoSelectFamily` would ask the lookup for every address and race them,
   so the row could not say which address answered and a partially filtered
   list would still be raced. The guarded lookup returns a single validated
   address and honours both callback shapes Node may ask for.
4. **The refusal reason is recorded by the lookup, not read off the socket
   error.** A per-request holder is written when an address is refused, so
   the difference between `DNS_ERROR` and `PRIVATE_NETWORK_BLOCKED` does not
   depend on a custom property surviving Node's socket error plumbing.
5. **Redirect revalidation has its own vocabulary, deliberately not
   `VERIFICATION_TARGET_FAILURES`.** That list is a registration vocabulary:
   every code in it has a user-facing `hostname_*` message
   (`features/deployments/deployment.ts`), and a person registering a name
   can never see a downgrade or a bad `Location`. `validateRedirectTarget`
   returns the §19 code that will be stored — `PRIVATE_NETWORK_BLOCKED` for
   a hop into private space, `REDIRECT_BLOCKED` for everything else — plus a
   precise reason for the log. Two audiences, two vocabularies.
6. **A redirect may carry a path; the original target may not.** A hop to
   `https://example.com/en/` is ordinary, so the path rule TASK-012 applies
   at registration is deliberately not applied to a hop. Everything else is:
   scheme, credentials, IP literals, reserved names, non-default ports.
7. **A `Location` to a bare IP address is refused even when it is public.**
   An honest site does not redirect its home page to an IP literal, the
   certificate cannot be checked against a name, and the address rules are
   the only thing standing between a hop and internal infrastructure.
8. **The size cap is a refusal, never a truncation.** A body over 1 MiB is
   `RESPONSE_TOO_LARGE` and is not inspected. Truncating and then inspecting
   would report `WIDGET_NOT_FOUND` for a page that may well contain the
   widget — false evidence in the one table whose value is that it can be
   relied on. `Content-Length` is checked first, so an oversized body is
   refused before it is read.
9. **`Accept-Encoding: identity`, with gzip, deflate and Brotli handled if
   they arrive anyway.** Decompression is bounded by `maxOutputLength`, so a
   compression bomb is `RESPONSE_TOO_LARGE` rather than memory. A server
   that ignores the request header and sends something else entirely is
   `UNKNOWN_ERROR`, which is the honest answer: we do not know what we got.
   Rejected: refusing every encoded response (a CDN that compresses
   regardless would produce bytes TASK-024 reads as "no widget", which is
   false evidence) and streaming decompression (the same cap, more moving
   parts).
10. **The body is returned as bytes, not a string.** Charset detection is
    part of reading HTML, and that is TASK-024. The transport does not
    interpret what it fetched; it reports the `Content-Type` it was given.
11. **Only `GET`, and a User-Agent that names us with a documentation URL.**
    A customer looking at their logs can tell what the traffic is, and can
    allow it deliberately rather than by guessing.
12. **A non-2xx response is `HTTP_ERROR` with the status recorded**, and a
    3xx with no usable `Location` is the same. The status is the evidence; a
    separate code per class would multiply §19 without telling anyone
    anything the number does not.
13. **The whole fetch is `server-only` and takes no caller-supplied
    bounds.** The options are a hostname and two test seams (the resolver
    and, for exercising the transport against a loopback server, the lookup
    itself). Bounds are module constants, so no future caller can widen
    them; the seams are named, documented and defaulted to the guarded
    path, and a test asserts the defaults are the guarded ones.

## Invariants

- **No socket is ever opened to an address `isPublicAddress` refuses**, on
  the first request or on any hop.
- **The address validated is the address connected to.** One resolution per
  hop, and its result is what the socket uses.
- **Every hop is revalidated as if it were the original target**, and never
  downgrades from HTTPS to HTTP.
- **Each bound has its own code**: `CONNECTION_TIMEOUT`, `TOTAL_TIMEOUT`,
  `RESPONSE_TOO_LARGE`, `TOO_MANY_REDIRECTS`.
- **A body over the cap is refused, never truncated and inspected.**
- **No customer page content is returned in `metadata`**, and from this task
  on the database refuses a key that is not on the list.
- **Nothing from the fetched page reaches a log**, beyond status, size,
  hostnames and timings.

## Acceptance criteria

- A hostname that resolves only to a private, loopback, link-local or
  metadata address is refused as `PRIVATE_NETWORK_BLOCKED`, with no
  connection attempted.
- A resolver failure is `DNS_ERROR`.
- A redirect chain ending at a private address is `REDIRECT_BLOCKED` before
  the final connection.
- A chain longer than 5 hops is `TOO_MANY_REDIRECTS`.
- An `https:` → `http:` hop is `REDIRECT_BLOCKED`.
- A body over 1 MiB is `RESPONSE_TOO_LARGE`, by `Content-Length` and by
  bytes actually read.
- A server that accepts the connection and never responds is
  `TOTAL_TIMEOUT`; one that never completes the connection is
  `CONNECTION_TIMEOUT`.
- A 404 and a 500 are each `HTTP_ERROR` with the status recorded.
- `metadata` accepts every key the fetch produces and refuses any other, in
  the database and in the row schema.

## Required tests

- security: each blocked target class through the real transport, a chain
  that ends private, a downgrade, an oversized body, and that the default
  options use the guarded lookup.
- unit: the guarded lookup against a fake resolver (both callback shapes,
  filtering, the recorded reason, one resolution); `validateRedirectTarget`
  for every reason; the transport against a real loopback server for
  redirects, bounds, encodings and statuses.
- pgTAP: the `metadata` key whitelist accepts the fetch's keys and refuses
  an unknown one.
- unit: the migration's key list equals the row schema's, in both
  directions.
