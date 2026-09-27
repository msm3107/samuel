## Handoff

### Summary

The verifier's fetch (TASK-023): a deployment's home page, fetched under four
bounds, with every redirect revalidated and no socket ever opened to an
address the public-address rules refuse. It also pays PR #39 note 4 —
`metadata` now has a key whitelist in the database.

**Nothing calls it yet.** TASK-024 inspects the bytes it returns, TASK-025
schedules the call and writes the evidence row.

**This pull request contains a migration.** Supabase's "Deploy to production"
applies it on merge. It is additive: two check constraints on a table that
holds no rows.

### Decisions

Owner, 2026-09-27.

1. **HTTPS first, then plain HTTP once.** If the connection or the TLS
   handshake fails, `http://` is tried once, and the row records which scheme
   answered and whether HTTPS failed first. A customer served over plain HTTP
   has the same disclosure obligation, and refusing to look would record a
   failure that is really about their certificate. Cost: the two attempts
   share one total-timeout budget, and plain-HTTP evidence is weaker — an
   attacker on the path could have written the page that was seen — so the
   scheme is part of the record.
2. **5s to connect, 15s in total, 1 MiB of body, 5 redirects.** 1 MiB clears
   the HTML of nearly every real site, so `RESPONSE_TOO_LARGE` stays a real
   finding rather than a routine false failure. Cost: one slow site can hold a
   worker for 15 seconds, and TASK-025 sizes its batches knowing it.
3. **A hop may go to any public host, never from HTTPS to HTTP.** Cross-host
   hops are ordinary; a downgrade is never required by an honest site and is
   exactly the step that turns a checked page into one an attacker on the path
   can write. Cost: a www redirect misconfigured as plain HTTP fails, under a
   code that points at the redirect rather than at the certificate.
4. **The `metadata` key whitelist lands here; TASK-024 adds its keys.** The
   protection exists a task earlier, and widening a whitelist by a named
   migration is a deliberate act rather than drift. Cost: two migrations
   against the constraint before any row exists.

Implementer (proposed, **awaiting sign-off**): `node:http` rather than `fetch`,
because each bound needs its own code and the resolved address has to be the
one connected to; DNS resolved once by a guarded `lookup` that is the only way
an address reaches the socket; Happy Eyeballs off, one validated address; the
refusal reason recorded by the lookup rather than read off the socket error;
redirect revalidation with its own vocabulary, deliberately not the
registration one; a hop may carry a path where the original may not; a
`Location` to a bare IP refused even when public; the size cap refuses and
never truncates; `Accept-Encoding: identity` with gzip, deflate and Brotli
handled anyway under a decompressed-output cap; the body returned as bytes;
`GET` only with a self-naming User-Agent; a non-2xx is `HTTP_ERROR` with the
status; and the whole thing `server-only` with bounds as module constants. The
contract states each one's reason and what was rejected.

**One of these widens README §19.** See below.

### Files changed

- `.ai/tasks/TASK-023-verification-fetch.md` (new): the contract
- `lib/security/verification-lookup.ts` (new): the guarded DNS lookup
- `lib/security/verification-target.ts`: `validateRedirectTarget` and
  `REDIRECT_REFUSALS`
- `features/verification/fetch-page.ts` (new): the transport and its bounds
- `features/verification/verification-check.ts`: the `metadata` schema, and
  `CONNECTION_FAILED`
- `supabase/migrations/20260927100000_verification_metadata_keys.sql` (new)
- `supabase/tests/verification_checks.test.sql`: four assertions, and one
  existing one made honest (below)
- `tests/unit/security/verification-lookup.test.ts` (new)
- `tests/unit/security/verification-target.test.ts`: the hop rules
- `tests/security/verification/verification-fetch.test.ts` (new)
- `tests/unit/verification/verification-check.test.ts`: the key whitelist
- `README.md` §6, §17, §19; `.ai/PLAN.md` Phase 7 and open question 5

### Security considerations

- **DNS rebinding is closed by shape, not by a check.** The guarded lookup
  resolves the name, drops every address `isPublicAddress` refuses, and hands
  the socket one. Node connects to exactly what the lookup returned, so there
  is no window between validating an address and connecting to it. Resolving
  separately and then connecting to the name would re-resolve, and a resolver
  that answered a public address the first time may answer
  `169.254.169.254` the second.
- **Happy Eyeballs is off.** `autoSelectFamily` asks the lookup for every
  address and races them, so a partially filtered list would still be raced
  and no row could say which address answered.
- **Connections are never reused.** `agent: false`, because the global agent
  keeps sockets alive and would skip the guarded lookup on a later request.
  The guarantee is per connection, so the connection is not shared.
- **The refusal reason is recorded by the lookup, not read off the socket
  error.** `net` rewrites the error it is handed, and the difference between
  `DNS_ERROR` and `PRIVATE_NETWORK_BLOCKED` is evidence — it must not depend
  on a custom property surviving Node's plumbing. The `lookup` test seam takes
  that record for the same reason: a lookup that refused without recording
  would land on `CONNECTION_FAILED`, a lie about why nothing connected.
- **Every hop is revalidated as if it were the original target**, and a hop
  into space the verifier may not reach is stored as
  `PRIVATE_NETWORK_BLOCKED` while everything else about a hop is
  `REDIRECT_BLOCKED` — because that is what happened: the redirect was not
  followed.
- **A `Location` to a bare IP is refused even when it is public.** An honest
  site does not redirect its home page to an address, no certificate can be
  checked against one, and the address rules are all that stand between a hop
  and internal infrastructure.
- **The size cap refuses and never truncates.** Inspecting a cut-off page
  would report `WIDGET_NOT_FOUND` for a page that may well contain the widget.
  `Content-Length` is checked first, and the cap applies again to bytes
  actually read, and again to decompressed output — so a compression bomb is
  `RESPONSE_TOO_LARGE` rather than memory.
- **Nothing from the page reaches `metadata`.** The whitelist is now a check
  constraint, and a test plants a string in the body and proves it is in the
  returned bytes and nowhere in the metadata.
- **No error message carries an address.** The lookup's error names the host
  and nothing else, because an error can reach a log and an internal address
  the resolver happened to return must not.
- **The bounds cannot be widened by a caller.** They are module constants. The
  three options the function does take are test seams, each documented as one,
  and none of them appears in application code.

### One code added to README §19

`CONNECTION_FAILED`. The name resolved and the connection was then refused,
reset, unreachable, or rejected at TLS — a site that is simply down, which is
the most common real failure there is. §19's set had no code for it, so it
would have landed on `UNKNOWN_ERROR`: a stored code that tells a customer
nothing, which is the opposite of what the section exists for.

It ships in this migration, before anything has written a row, and the list is
replaced rather than extended because a check constraint has no `add value` —
which is the cost TASK-022 accepted when it chose text with a constraint over
a Postgres enum, and this is the first time that cost has been paid.

### The `metadata` whitelist, and what it does not do

Seven keys: `scheme`, `https_failed`, `redirects`, `final_host`,
`response_bytes`, `duration_ms`, `content_type`. Enforced three ways — a check
constraint, a `z.strictObject` row schema, and a unit test that keeps the two
equal in both directions, since a key the schema knows that the constraint
refuses would fail every write, and a key the constraint allows that the
schema has never heard of is a key nobody reviewed.

The constraint is `metadata - array[…] = '{}'::jsonb`, because a CHECK
constraint may not contain a subquery and so `jsonb_object_keys` is
unavailable. Deleting every allowed key and requiring an empty object left
over says the same thing in one expression, with no function to keep immutable.
A `jsonb_typeof` guard comes first, because `-` raises on a scalar rather than
returning false and TASK-022's own constraint already refuses a non-object
with the error code its tests pin.

**A whitelist bounds keys, not values** — the reviewer's own limitation, now
recorded in the migration, in the column comment and in README §6. Nothing
stops a future writer putting a page excerpt in `content_type`. What it stops
is a key nobody reviewed, and it makes the next attempt a migration rather
than a habit.

### One existing pgTAP assertion made honest

`'metadata that is not an object is refused'` inserted a `success` row with no
`http_status` and no `widget_detected`, which the PR #39 note 3 constraint also
refuses with `23514`. It passed, but it could not distinguish its own
constraint from that one. It is now a coherent success, so the only constraint
left that can refuse it is the one it names — and every new assertion in this
task is written the same way.

### Tests

- **Unit, the guarded lookup against a fake resolver.** The fake is the point:
  no test machine can own `169.254.169.254`, and a test that resolved a real
  public name would depend on that name still resolving the way it did when
  the test was written. Ten blocked classes; both callback shapes; a rebinding
  answer that hides a private address behind a public one; a name that does
  not resolve told apart from one that resolves privately; the error naming the
  host and not the address; one resolution per attempt; and the family
  spelling `net` may pass.
- **Unit, `validateRedirectTarget`.** Six hops followed, seventeen refused with
  the exact reason and the §19 code it becomes, and an assertion that the
  registration vocabulary and the redirect one stay separate.
- **Security, the fetch against a real loopback server.** Thirty tests:
  every blocked target class with the server live on the very port the fetch
  would use, so "the server saw nothing" is a claim about the guard rather
  than about the port; a chain that ends at a loopback address, at a private
  name no reserved-name rule catches, at a non-default port, at a public IP
  literal and at a non-HTTP scheme; a chain of two hops that changes host; the
  redirect bound; the size cap by declared length, by bytes read, and at
  exactly the cap; four HTTP statuses and a 3xx with no `Location`; a gzipped
  body, a compression bomb and an encoding we cannot read; the User-Agent and
  `Accept-Encoding` a customer's log will show; a planted string proving page
  content reaches the caller and not the metadata; and both timeouts against
  real clocks.
- **pgTAP**: a key nobody put on the whitelist, one unknown key among allowed
  ones, every key the fetch produces, and `CONNECTION_FAILED` as a stored code.
- **Unit**: the migration's key list equals the row schema's, and the
  migration's code list equals `VERIFICATION_FAILURE_CODES` — the existing
  test, which now reads the constraint out of this task's migration, because
  it deliberately reads the latest one that defines it.

### What the tests cannot compose, stated rather than hidden

The SSRF proofs need the real guarded lookup and a fake resolver. The
transport proofs need a real server, which is on loopback — the address the
guarded lookup exists to refuse. Both are exercised, and one hop rule is
proven only at the validator: the **HTTPS-to-HTTP downgrade**, because
reaching it through the chain needs a TLS server whose certificate the suite
would have to mint. Every other hop rule is proven through the chain, so the
chain is known to pass hops through the validator that refuses the downgrade.

The two timeout tests wait for real bounds — about twenty seconds of the
suite's runtime between them. The bounds are module constants on purpose, so
there is no clock to inject; the alternative was mocking the thing under test.

### Commands run

On the final state of the branch:

```
pnpm typecheck                       pass (both projects)
pnpm lint                            pass
pnpm format:check                    pass
pnpm test                            68 files, 1814 tests, pass
supabase test db --local             9 files, 326 tests, pass
vitest --config vitest.supabase.*    34 files, 413 tests, pass
pnpm test:e2e:supabase               31 tests, pass
next build                           pass
```

The database was reset to the migration head before the database suites and
again before the browser suite; both new constraints applied cleanly to an
empty table. `CODEX-SECURITY.md`'s sha256 was checked before and after
Prettier: unchanged. Prettier was run on changed files by name rather than
across the tree, for the same reason.

### Before merging

- **This migration runs on merge.** Two check constraints added to
  `verification_checks`, one dropped and re-added with one more allowed value.
  The table holds no rows, so validation is instant and nothing can fail it.
- **It alters no other table**, creates no function and no trigger.
- **Nothing calls the fetch yet.** The application is unchanged in behaviour.

### Remaining concerns

- **TASK-024 is next**: HTML inspection and the failure-code mapping —
  `WIDGET_NOT_FOUND`, `DEPLOYMENT_ID_MISMATCH`, `DISCLOSURE_VERSION_MISMATCH`
  — over the bytes this task returns, plus its own `metadata` keys added to
  the whitelist.
- **Charset decoding is TASK-024's.** The transport returns bytes and the
  `Content-Type` it was given; it does not interpret what it fetched.
- **TASK-025's window size is still a storage decision** (PR #39 note 1), and
  it now also has to account for a fifteen-second worst case per deployment.
- **A per-organization or per-host concurrency limit is not in this task.**
  One target can cost fifteen seconds; a customer with many deployments on one
  host can be fetched many times in a run. That belongs with the scheduler.
- **Owed, unchanged:** `learnMoreUrl` as a whole; a cache purge on publish; a
  hard ceiling at the edge if the public endpoint's alert fires; key rotation
  plus `git stash drop`; stale-save protection on the AI system edit form; a
  member directory if a publisher is ever to be named; §20's hash chain and
  its ordering question.
