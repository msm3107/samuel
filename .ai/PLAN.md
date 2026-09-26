# Implementation Plan

The route from the current repository foundation to a product that can take
paying customers. `README.md` §70 gives the build order; this file turns it into
phases with dependencies, security invariants, and exit criteria, and names the
task contracts that carry each phase.

`AGENTS.md` still governs how the work is done. Where this plan and `AGENTS.md`
disagree, `AGENTS.md` wins.

## How to read this

Each phase states what it delivers, what it depends on, the security invariants
it introduces, and what "done" means for it. Phases are sequential unless the
dependency graph says otherwise.

A phase is complete when its exit criteria hold **and** `README.md` §60 holds
for every task inside it. A phase is not complete because its code exists.

Task IDs are allocated per phase. Contracts exist under `.ai/tasks/` for phases
that are immediately actionable; later phases list their intended tasks so the
dependency graph is legible, and get written contracts when their turn comes.
Writing all of them now would encode assumptions that the intervening phases
will invalidate.

---

## Phase 0 — Repository foundation — **complete**

Tooling, documentation, agent contracts, validated configuration, structured
logging with redaction, nonce CSP and security headers, CI.

Delivered in PR #1.

---

## Phase 1 — Authentication

**Goal.** A person can sign in, and server code can trust who they are.

**Tasks.**

| ID        | Owner              | Deliverable                                                                               |
| --------- | ------------------ | ----------------------------------------------------------------------------------------- |
| TASK-001  | Database           | Supabase client boundary: server-session, proxy-session, and service-role factories       |
| TASK-002  | Backend            | `requireSession()` and route protection for `/dashboard`                                  |
| TASK-003a | Backend            | Sign-in server flow: magic link, Google OAuth start, PKCE callback, sign-out              |
| TASK-003b | Database + Testing | Local Supabase config, real-Supabase test suite, e2e CI workflow (approved)               |
| TASK-003  | Frontend           | `/sign-in` with magic link and Google OAuth, plus Playwright                              |
| TASK-003c | Database + Backend | Application rate limiting on sign-in (Postgres-backed; lands the Phase 6 primitive early) |

Order: TASK-003a, then TASK-003 (screen and keyboard e2e). TASK-003b can run
alongside TASK-003a (they touch different files) and is required before the
Phase 1 exit criteria can be proven. TASK-003c follows TASK-003b, whose local
Supabase it needs to apply and test its migration.

**Depends on.** Phase 0.

**Security invariants introduced.**

- Identity comes from a server-side session lookup, never from a request body,
  query parameter, header, or client-supplied `userId`.
- The service-role client is constructed in exactly one module, is never
  imported by a client component, and is never used to serve a user request
  that could be served by the session client.
- Unauthenticated requests to a dashboard route redirect to `/sign-in` and
  leak nothing about whether the requested resource exists.

**Exit criteria.**

- Sign-in works end to end against a local Supabase instance.
- An integration test proves an unauthenticated dashboard request fails.
- A test proves a request carrying another user's `userId` is ignored rather
  than honored.
- No `NEXT_PUBLIC_` variable exposes a service credential; `pnpm build` output
  is inspected for the service-role key.

**Risks.** The session client must work in server components, route handlers,
and the proxy, which read and write cookies differently. Getting this wrong
produces intermittent logged-out states that look like a Supabase bug. Settle
the cookie handling in TASK-001 before any feature depends on it.

---

## Phase 2 — Organizations, membership, authorization core

`README.md` §70 lists "organizations + membership" and "tenant-safe database
schema" separately. They are one phase here: the membership tables _are_ the
tenant-safe baseline, and splitting them would mean writing the RLS policies
twice against a moving target.

**Goal.** Every later query has an organization to scope to, and a single
helper to authorize against.

**Tasks.**

| ID       | Owner              | Deliverable                                                                        |
| -------- | ------------------ | ---------------------------------------------------------------------------------- |
| TASK-004 | Database           | `organizations` and `memberships` migration, RLS, indexes, constraints             |
| TASK-005 | Backend            | `requireOrganizationRole()` and the role hierarchy                                 |
| TASK-006 | Database + Backend | `audit_events` table and `recordAuditEvent()`                                      |
| TASK-007 | Backend + Testing  | Organization creation with first-owner membership, plus the tenant-isolation suite |

**Depends on.** Phase 1.

**Security invariants introduced.**

- Every organization-owned table carries `organization_id uuid not null` with a
  foreign key.
- RLS is enabled on every user-accessible tenant table, in the same migration
  that creates the table.
- Role comparison happens in one place. `owner > admin > member > viewer` is
  defined once and never re-implemented as an inline conditional.
- Creating an organization and its owner membership is atomic. A failure
  between the two must not leave an organization nobody can administer.
- Audit events record actor, organization, entity, and type — never
  credentials, tokens, payment data, or personal information beyond the actor's
  user ID.

**Exit criteria.**

- The tenant-isolation suite in `tests/security/` proves all five checks from
  `README.md` §8, exercised through RLS and again through application code.
- A viewer cannot write. An admin cannot modify an owner.
- `pnpm test:security` is wired into `security.yml` and passing on real
  assertions rather than `--passWithNoTests`.

**Risks.** This phase sets the shape every later feature copies. A weak
`requireOrganizationRole` signature — one that accepts an organization ID the
caller did not prove membership of — propagates into every subsequent route.
Review this task contract more carefully than its size suggests.

---

## Phase 3 — AI systems

**Goal.** An organization can register the AI systems it needs to disclose.

**Tasks.** TASK-008 (schema + RLS), TASK-009 (CRUD services and routes),
TASK-010 (dashboard screens: list, new, detail).

**Depends on.** Phase 2.

**Security invariants introduced.**

- `system_type` is a database enum or check constraint, not a free string.
- Every query is scoped by `organization_id`; lookup by primary key alone does
  not exist in this feature.
- Responses use explicit serializers.

**Exit criteria.** Cross-tenant read, write, and enumeration of AI systems all
fail, proven by test. `/dashboard/systems` is keyboard-navigable with visible
focus states.

---

## Phase 4 — Deployments

**Goal.** An organization can register where a system is publicly deployed.

**Tasks.** TASK-011 (schema + RLS + unique constraint on the system/hostname
pair), TASK-012 (`normalizeHostname()` and `validateVerificationTarget()` in
`lib/security/`), TASK-013 (CRUD services and routes), TASK-014 (public
deployment identifier generation), TASK-015 (deployment detail screen).

**Depends on.** Phase 3.

**Shared primitive.** `lib/security/verification-target.ts` lands here, before
the verifier needs it, because deployment creation must already reject private
and loopback targets. Phase 7 extends the same module with resolve-time checks
and redirect revalidation rather than writing a second validator. Two SSRF
validators is the failure mode to avoid.

**Security invariants introduced.**

- Hostnames are normalized before storage and before comparison: lowercased,
  trailing dot stripped, IDN punycode-encoded, length-bounded.
- Registration rejects loopback, private IPv4 and IPv6 ranges, link-local
  ranges, cloud metadata endpoints, embedded credentials, non-HTTP schemes, and
  unexpected ports.
- Public deployment identifiers come from a CSPRNG and carry enough entropy to
  resist enumeration — while never being treated as authorization (§67).

**Exit criteria.** `tests/security/` proves that localhost, `127.0.0.1`,
`169.254.169.254`, `[::1]`, a private IPv6 address, an embedded-credential URL,
and a non-HTTP scheme are each rejected with the correct deterministic failure
code.

---

## Phase 5 — Disclosures — **complete**

**Goal.** An organization can configure the disclosure text a deployment shows.

**Tasks.** TASK-016 (schema + RLS + immutability constraint), TASK-017
(versioning service), TASK-018 (configuration UI), TASK-018a (paging the
version history: a "before version N" parameter and the screen's way to
older versions; PR #32 review, note 3, Mikołaj Smoliniec, project owner,
2026-09-23. The history endpoint caps at 200, and older versions are
evidence).

**Depends on.** Phase 3.

**Runs in parallel with.** Phase 4. Disclosures hang off `ai_systems`, not off
`deployments`, so the two phases touch different files. Assign them to
different agents concurrently; do not let either edit the other's migration.

**Security invariants introduced.**

- A published disclosure version is immutable. Editing inserts a new version;
  the database enforces this rather than the application remembering to.
- `message` is plain text. No HTML, no markdown rendering, no
  `dangerouslySetInnerHTML` anywhere in the path from storage to the widget.
- `language` is constrained to a known set.

**Exit criteria.** An attempt to update a published version fails at the
database level, proven by an integration test rather than by convention.

---

## Phase 6 — Public widget and configuration endpoint — **complete**

**Goal.** One script tag renders the disclosure on a customer site.

**Tasks.** TASK-019 (the public disclosure lookup: a `security definer`
function granted to `anon`, in its own migration), TASK-019a (the public
configuration endpoint that calls it, with rate limiting, CORS and caching),
TASK-020 (`widget.js`), TASK-021 (installation instructions in the
dashboard).

TASK-019 is two pull requests because the lookup is a migration and the
endpoint reads it: a migration adding a function the application reads ships
before the code that reads it (owner, 2026-09-25; PR #35).

**Known limit, to settle in this phase.** Nothing purges the shared cache
when a notice is published or withdrawn, so the endpoint's 60-second cache
and its five minutes of background revalidation are not only the typical
delay but the floor on how fast a customer can take a wrong notice down —
about six minutes (owner, 2026-09-26; PR #36 review). The fix, if one is
wanted once the widget exists, is a purge call in the publish path, not a
shorter cache header: a shorter header pays on every page view of every
customer site, while a purge pays only when something actually changed.

**Depends on.** Phases 4 and 5.

**Shared primitive.** Rate limiting was planned to land here, because the
public endpoint is the first unauthenticated surface. It landed earlier
instead: `lib/security/rate-limit.ts` was written in Phase 1 for sign-in
(TASK-003c), so TASK-019a adds entries to `RATE_LIMITS` and calls
`consumeRateLimit` rather than writing a second implementation — which is
what this paragraph asked for either way. Phase 10 reuses the same one for
webhooks.

**Security invariants introduced.**

- The public endpoint returns only `version`, `language` and `message`. No
  database identifiers, no organization metadata, no verification state.
  `learnMoreUrl` was listed here and is deferred (owner, 2026-09-25): no
  column stores one and no screen can set one, so it would be an
  always-null key. It joins this list with the column, the editor field and
  the widget's link, in one later task.
- The widget contains no secret, calls no private API, and uses no `eval`,
  `new Function`, `document.write`, inline handler, or remote code load.
- The widget sets no cookie, reads no `localStorage`, and collects nothing.
- The widget never throws into the customer's page and never blocks its
  rendering: every failure ends in rendering nothing. It is silent about a
  deployment with nothing to show, which is an ordinary state and must not
  be distinguishable from any other. It may write one console line per page
  load for a mistake in the installation, or for a failure that is not that
  ordinary answer (owner, 2026-09-26; PR #37 review, note 3) — a broken
  installation is otherwise indistinguishable from a working one.
- The endpoint's CORS policy permits reading configuration cross-origin; that
  is a deliberate exception and is not authorization.
- `NEXT_PUBLIC_APP_URL` is part of the public contract from TASK-021. It is
  no longer only the host members sign in to: the dashboard bakes it into
  script tags on customers' pages and into the `script-src` and
  `connect-src` directives of their Content Security Policies. It can change
  only behind a permanent redirect for `/widget.js` and `/api/public/…` from
  the old host, kept indefinitely (owner, 2026-09-26; PR #38 review, note
  1). A domain change would otherwise fail silently on the customer's side:
  the widget is deliberately quiet about a network error, and a `404` from
  whoever holds the old domain next is indistinguishable from the ordinary
  empty answer. Serving customers from a host separate from the dashboard's
  is the exit if it ever has to move, and would also stop the dashboard's
  cookie origin being the origin the whole internet calls.

**Exit criteria.** The widget is under 10 KB compressed, measured and
recorded — of the shipped file itself, since it is deliberately not built
(TASK-020): 4191 bytes gzipped from 11566 bytes of source. A test asserts
the response body contains no key beyond the three documented. The widget
is verified against a page that already defines conflicting global names
and CSS. The dashboard generates the installation for a deployment, and a
browser test installs exactly what it generated, unedited, on a page at
another origin (TASK-021) — an install document that drifts from the
product is the one failure a document cannot catch about itself.

**Decision taken before starting.** `widget.js` is served from the
application origin (owner, 2026-09-26; open decision 1, TASK-020). The
customer allows one host in `script-src` and `connect-src`, the script is one
URL revalidated hourly, and the widget finds the configuration endpoint from
its own script URL.

**Decision taken in TASK-021.** The dashboard generates the tag from
`NEXT_PUBLIC_APP_URL`, not from the request's host (owner, 2026-09-26): one
configured truth, already what `lib/http/api.ts` trusts as this
deployment's own origin, so every member is handed the same snippet whatever
host they reached the dashboard on. The deployment page also says whether an
installed tag would render anything — the public endpoint answers
identically for all six reasons it would not, deliberately, so the dashboard
is the only place those can be told apart for the person entitled to know.

---

## Phase 7 — Verification service

**Goal.** A scheduled job checks whether the disclosure is actually present.

**Tasks.** TASK-022 (`verification_checks` schema, append-only, with the
integrity columns reserved), TASK-023 (SSRF-hardened fetch with redirect
revalidation), TASK-024 (HTML inspection and failure-code mapping), TASK-025
(cron route authenticated by `CRON_SECRET`, idempotent per deployment per
window).

**Depends on.** Phase 6.

**Security invariants introduced.**

- DNS is not trusted once. The address resolved is the address connected to, or
  the resolved address is re-validated immediately before connection, so a
  rebinding response cannot redirect the fetch into internal infrastructure.
- Every redirect target is re-validated as if it were the original target.
- Connection timeout, total timeout, response-size cap, and redirect count are
  all bounded, and each exceeded bound maps to its own failure code.
- Customer JavaScript is never executed. MVP verification inspects HTML only.
- The cron route rejects an absent, wrong, or short `CRON_SECRET`, comparing in
  constant time.

**Exit criteria.** `tests/security/` proves rejection of each blocked target
class, a redirect chain that ends at a private address, a response exceeding
the size cap, and an unauthenticated cron call. The job emits a structured
success or failure result for every run — a silent failure here is a
compliance failure the customer discovers months later.

**Note on evidence integrity.** `payload_hash` and `previous_record_hash`
columns are created nullable in TASK-022 and left unpopulated. §20 does not
require the chain for launch, but adding the columns later means a migration
across evidence rows that customers are already relying on.

---

## Phase 8 — Verification history

**Goal.** A customer can see and trust what was checked, and when.

**Tasks.** TASK-026 (history queries with bounded pagination), TASK-027
(history UI with non-color status communication).

**Depends on.** Phase 7.

**Security invariants introduced.**

- History is read-only through every path. No route, service, or admin screen
  offers an update or delete of a verification check.
- Status is communicated by text and shape, not color alone (§35).

**Exit criteria.** Cross-tenant history reads fail. Pagination is bounded; no
query can be made to return an unbounded result set.

---

## Phase 9 — Evidence reports

**Goal.** A customer can export a record of configuration and verification.

**Tasks.** TASK-028 (report generation service, idempotent per request),
TASK-029 (PDF rendering), TASK-030 (report download route).

**Depends on.** Phase 8.

**Security invariants introduced.**

- A report is generated only for an organization the caller is a member of,
  re-checked server-side at generation and again at download.
- The report identifier is unguessable and is still not authorization.
- Generation is idempotent: a retried request does not produce a divergent
  second report for the same inputs.

**Exit criteria.** Every report carries the §21 disclaimer verbatim. No report,
filename, heading, or download path uses the words "certificate",
"certification", or "compliant" (§21, §72) — assert this in a test, because it
is the claim most likely to drift back in under commercial pressure.

---

## Phase 10 — Stripe billing

**Goal.** An organization can subscribe, and the application reflects Stripe's
state rather than the browser's.

**Tasks.** TASK-031 (billing columns and plan state), TASK-032 (Checkout
session creation, owner-only), TASK-033 (webhook handler with signature
verification and idempotency), TASK-034 (billing screen and cancellation).

**Depends on.** Phase 2 for roles; otherwise independent of Phases 3–9 and can
run in parallel with Phase 8 or 9 if agent capacity allows.

**Security invariants introduced.**

- The webhook reads the raw body before any parsing, verifies the signature,
  and rejects on failure without disclosing why.
- Processing is idempotent on the Stripe event ID, enforced by a unique
  constraint rather than a check-then-insert.
- Price and plan are never accepted from the browser. The client names a plan;
  the server resolves the price ID from validated configuration.
- Only an `owner` may start checkout, change a plan, or cancel.
- Logs record the Stripe event ID and nothing else from the payload.

**Exit criteria.** A tampered webhook signature fails, proven by test. A
replayed event produces no second effect, proven by test. Cancellation works
end to end against Stripe test mode. The `STRIPE_PRICE_*` variables move from
optional to required in `lib/env/server-env.ts` as part of TASK-031 — they are
optional today only because nothing consumes them yet.

---

## Phase 11 — Agency UX

**Goal.** One account manages many client deployments without friction.

**Tasks.** TASK-035 (organization switcher), TASK-036 (member invitations with
idempotent acceptance), TASK-037 (cross-client deployment overview).

**Depends on.** Phases 3, 4, and 8.

**Security invariants introduced.**

- Switching organizations re-resolves membership server-side. The switcher is a
  UI affordance over an authorization check, never a substitute for one.
- An invitation token is single-use, expiring, and scoped to one organization
  and role. Accepting twice is a no-op, not a second membership.
- An invitation cannot grant a role above the inviter's own.

**Exit criteria.** A member cannot invite an owner. An expired or reused
invitation fails. The overview leaks no organization the user does not belong
to, including through counts, totals, or timing.

---

## Phase 12 — Observability

**Goal.** The team learns about failures before customers do.

**Tasks.** TASK-038 (Sentry wiring with scrubbing), TASK-039 (health metrics
for verification rate, latency, webhook failures, cron success), TASK-040
(alerting on cron failure and webhook failure).

**Depends on.** Phases 7 and 10.

**Security invariants introduced.**

- Telemetry is scrubbed before transmission: no tokens, cookies, headers,
  payment data, or disclosure content containing customer text.
- Metrics track application health, not user behavior (§74).

**Exit criteria.** A deliberately failed cron run produces an alert. A silent
failure path is demonstrated not to exist for any scheduled job.

---

## Phase 13 — Production readiness gate

**Goal.** Establish that the service can hold other people's compliance
evidence.

**Tasks.** TASK-041 (security agent review of the whole surface), TASK-042
(retention and deletion policy implementation per §33), TASK-043 (backup and
restore rehearsal), TASK-044 (the §75 checklist, item by item, with evidence).

**Depends on.** Everything.

**Exit criteria.** Every line of `README.md` §75 is checked with a link to the
test, run, or document that establishes it. A restore from backup has actually
been performed, not merely configured. The security agent's verdict is
`APPROVE` or `APPROVE WITH NON-BLOCKING NOTES`, recorded in `.ai/handoffs/`.

This phase has veto power. It is not a formality to clear on the way to launch.

---

## Critical path and parallelization

```
Phase 0 ✓
   │
Phase 1  authentication
   │
Phase 2  organizations, membership, authorization core
   │
Phase 3  AI systems
   ├───────────────┐
Phase 4          Phase 5            (parallel: different files, different agents)
deployments      disclosures
   └───────┬───────┘
      Phase 6  widget + public config
           │
      Phase 7  verification
           │
      Phase 8  history ───────┐
           │                  │
      Phase 9  reports    Phase 10  Stripe   (parallel from Phase 2 onward)
           └────────┬─────────┘
             Phase 11  agency UX
                  │
             Phase 12  observability
                  │
             Phase 13  readiness gate
```

Phases 1, 2, 6, 7, and 13 are on the critical path and should not be worked
concurrently with anything that touches their files. Phase 10 depends only on
Phase 2 and is the best candidate for a second agent working in parallel.

---

## Shared primitives, and the phase that owns them

Each of these is written once, by the phase named, before the phases that
consume it. A second implementation of any of them is a review rejection.

| Primitive                                    | Module                       | Owning phase     | Later consumers |
| -------------------------------------------- | ---------------------------- | ---------------- | --------------- |
| Supabase client factories                    | `lib/database/`              | 1                | everything      |
| Session resolution                           | `lib/auth/`                  | 1                | everything      |
| Role hierarchy and `requireOrganizationRole` | `lib/auth/`                  | 2                | 3–11            |
| Audit event recording                        | `features/organizations/`    | 2                | 3–11            |
| Hostname normalization                       | `lib/security/`              | 4                | 6, 7            |
| Verification target validation (SSRF)        | `lib/security/`              | 4, extended in 7 | 7               |
| Public identifier generation                 | `lib/security/`              | 4                | 6, 9            |
| Rate limiting                                | `lib/security/`              | 1 (TASK-003c)    | 6, 10           |
| Typed domain errors                          | per feature, shape agreed in | 2                | everything      |

---

## Open decisions

These block the phases named. Each needs a human answer; none should be
resolved by an agent picking a default. A decided one keeps its number and
records the answer, so a reader of an old handoff still finds it.

1. **Widget hosting origin** — ~~application origin or a separate CDN
   domain~~. **Decided: the application origin** (owner, 2026-09-26;
   TASK-020). `/widget.js` is served from the host the dashboard is on, so a
   customer allows one origin in both `script-src` and `connect-src`, and the
   widget finds the configuration endpoint from its own script URL. A CDN
   domain was rejected: it does not exist, it would have blocked the phase on
   infrastructure, and it would make customers allow two hosts. Moving to one
   later means baking the API origin in at build time.
2. **Evidence retention policy** — how long verification checks survive
   organization deletion, and what "delete my data" means when the evidence is
   the product. Blocks Phase 13, and should be decided before Phase 7 writes
   the first durable evidence row.
3. **Verification frequency and its billing tier** — daily for everyone, or
   tiered. Blocks Phase 7's cron schedule and Phase 10's plan definitions.
4. **Supported disclosure languages at launch** — constrains the Phase 5 enum.
   Adding a language later is cheap; removing one customers already publish is
   not.
5. **DNS rebinding strategy** — pinning the resolved address versus
   re-validating immediately before connect. Blocks TASK-023. The choice
   depends on the hosting platform's outbound networking, which should be
   confirmed rather than assumed.
6. **Whether the public transparency page (§68) is in the launch scope** —
   currently unscheduled in this plan. It is a distinct public surface with its
   own exposure rules and deserves its own phase if it ships.

---

## First-day scope

`README.md` §71 describes a disciplined one-day build. Against this plan that
is: Phase 1, Phase 2 restricted to a single organization per user, the create
paths only of Phases 3 and 4, Phase 5 without version history UI, Phase 6, a
minimal Phase 7 with manual triggering, and Phase 10's checkout path only.

The architectural rules apply in full from the first commit. The feature
surface is what shrinks.

---

## Non-goals

Not in this plan, and not to be introduced without an observed production
requirement: Redis, queues, Kubernetes, microservices, Kafka, event
infrastructure, custom RBAC, workflow automation, multi-region deployment,
analytics products, AI copilots, and native mobile applications.
