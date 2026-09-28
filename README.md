# Article50.js

AI transparency infrastructure for agencies and SaaS teams deploying customer-facing AI systems in Europe.

Article50.js provides a lightweight disclosure widget, deployment monitoring, evidence history, transparency pages, and exportable compliance records for AI systems.

> Article50.js is compliance infrastructure, not legal advice.
> The product must never claim that installation guarantees compliance with the EU AI Act or any other law.

---

## 1. Product Goal

The MVP should let a customer:

1. Create an organization.
2. Register an AI system.
3. Register one or more deployment domains.
4. Configure a transparency disclosure.
5. Install one small script tag.
6. Automatically verify that the disclosure is present.
7. Preserve an immutable verification history.
8. Generate an evidence report.
9. Manage multiple client deployments from one agency account.

The initial product should feel closer to Stripe Checkout than to enterprise governance software.

The core promise:

> Add AI transparency disclosures and maintain evidence across every client deployment from one dashboard.

---

## 2. Engineering Principles

This repository optimizes for:

- security over convenience
- correctness over cleverness
- readability over abstraction
- boring technology over fashionable complexity
- explicit behavior over hidden magic
- deterministic behavior over agent improvisation
- tenant isolation by default
- server-side authorization by default
- immutable evidence where practical
- observable production behavior
- small modules with narrow responsibility
- automated validation before deployment

Code should be understandable by a strong engineer who has never seen the repository before.

If a function needs a large comment explaining what it does, strongly consider simplifying the function.

If an abstraction has only one consumer, strongly consider removing the abstraction.

If a dependency can reasonably be avoided, avoid it.

---

## 3. Recommended Stack

| Concern         | Choice                               |
| --------------- | ------------------------------------ |
| Framework       | Next.js 15+                          |
| Language        | TypeScript, strict mode              |
| Package manager | pnpm                                 |
| Database        | PostgreSQL via Supabase              |
| Authentication  | Supabase Auth                        |
| Validation      | Zod                                  |
| Payments        | Stripe                               |
| Styling         | Tailwind CSS                         |
| Components      | shadcn/ui where useful               |
| Monitoring      | Sentry                               |
| Logging         | Pino / structured JSON               |
| Testing         | Vitest                               |
| E2E testing     | Playwright                           |
| Formatting      | Prettier                             |
| Linting         | ESLint                               |
| Git hooks       | simple-git-hooks or Husky            |
| CI              | GitHub Actions                       |
| Hosting         | Vercel                               |
| Scheduled jobs  | Vercel Cron initially                |
| PDF generation  | React PDF or server-side HTML to PDF |

Do not introduce Redis, queues, Kubernetes, microservices, Kafka, or event infrastructure during MVP unless an observed production requirement justifies them.

---

## 4. Architecture

The application consists of four logical components.

```
┌──────────────────────────────────────────────┐
│                Dashboard                     │
│                                              │
│  Next.js App Router                          │
│  Auth                                        │
│  Organizations                               │
│  AI Systems                                  │
│  Deployments                                 │
│  Verification History                        │
│  Evidence Reports                            │
└───────────────────┬──────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────┐
│             Application Layer                │
│                                              │
│  authorization                               │
│  domain validation                           │
│  disclosure configuration                    │
│  verification service                        │
│  evidence generation                         │
│  billing                                     │
└───────────────────┬──────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────┐
│                 PostgreSQL                   │
│                                              │
│  organizations                               │
│  memberships                                 │
│  ai_systems                                  │
│  deployments                                 │
│  disclosures                                 │
│  verification_checks                         │
│  audit_events                                │
└──────────────────────────────────────────────┘
```

Public infrastructure:

```
customer website
      │
      ▼
/widget.js
      │
      ▼
public configuration endpoint
      │
      ▼
disclosure rendered

scheduled verifier
      │
      ▼
customer website
      │
      ▼
verification_checks
```

The public widget and authenticated dashboard must remain logically separated.

---

## 5. Repository Structure

```
article50/
├── .github/
│   ├── workflows/
│   │   ├── ci.yml
│   │   └── security.yml
│   └── pull_request_template.md
│
├── .ai/
│   ├── agents/
│   │   ├── orchestrator.md
│   │   ├── backend.md
│   │   ├── frontend.md
│   │   ├── database.md
│   │   ├── security.md
│   │   ├── testing.md
│   │   └── reviewer.md
│   │
│   ├── tasks/
│   │   └── README.md
│   │
│   └── handoffs/
│       └── README.md
│
├── app/
│   ├── (auth)/
│   ├── (dashboard)/
│   ├── api/
│   ├── transparency/
│   ├── layout.tsx
│   └── page.tsx
│
├── components/
│   ├── ui/
│   ├── forms/
│   └── dashboard/
│
├── features/
│   ├── ai-systems/
│   ├── organizations/
│   ├── deployments/
│   ├── disclosures/
│   ├── verification/
│   ├── evidence/
│   └── billing/
│
├── lib/
│   ├── auth/
│   ├── database/
│   ├── security/
│   ├── logging/
│   ├── env/
│   ├── stripe/
│   └── validation/
│
├── public/
│   └── widget/
│
├── scripts/
│   ├── verify-deployments.ts
│   └── seed.ts
│
├── supabase/
│   ├── migrations/
│   └── seed.sql
│
├── tests/
│   ├── integration/
│   ├── security/
│   └── e2e/
│
├── middleware.ts
├── AGENTS.md
├── README.md
├── SECURITY.md
├── CONTRIBUTING.md
├── eslint.config.mjs
├── next.config.ts
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## 6. Domain Model

### organizations

Represents a customer or agency.

```
id
name
slug
created_at
updated_at
```

### memberships

Maps authenticated users to organizations.

```
id
organization_id
user_id
role
```

`role`:

```
owner
admin
member
viewer
```

Every authenticated resource must ultimately resolve through an organization membership.

### ai_systems

Represents an AI system being disclosed.

```
id
organization_id
name
description
system_type
provider
status
created_at
updated_at
```

Possible `system_type` values:

```
chatbot
voice_agent
assistant
generator
other
```

### deployments

Represents where an AI system is publicly deployed.

```
id
organization_id
ai_system_id
hostname
status
created_at
updated_at
```

Example:

```
support.example.com
```

Store normalized hostnames.

Do not store arbitrary unvalidated URLs when a hostname is sufficient.

### disclosures

Represents disclosure configuration.

```
id
organization_id
ai_system_id
version
message
language
enabled
created_at
created_by
```

Published disclosure versions should be immutable.

Editing a published disclosure creates a new version.

### verification_checks

Append-only evidence that a deployment was checked.

```
id
organization_id
deployment_id
disclosure_id
status
checked_at
check_window
http_status
widget_detected
disclosure_version
failure_code
metadata
payload_hash
previous_record_hash
```

`check_window` is the start of the schedule window a check belongs to, with
`unique (deployment_id, check_window)`: a cron that fires twice cannot write
two rows for one window (TASK-022). The two hash columns are §20's chain,
created nullable and unpopulated.

`status` is `success` or `failure`; `failure_code` carries the reason and is
null exactly when the status is success.

`metadata` holds facts about the check and never content fetched from the
customer's page. From TASK-023 that is a database rule rather than a habit: a
check constraint names the keys it may hold, so a new one needs a migration
somebody reviews. A whitelist bounds keys, not values — it is the reviewer of
that migration, not the constraint, who is the last line against page content
reaching the column.

TASK-024 widened it once, as TASK-023 said it would, with what the inspection
observes: `charset`, `widget_tags` and `widget_reason`. One key was asked for
and refused — the deployment identifier found on the page. It is the most
useful fact there is for a `DEPLOYMENT_ID_MISMATCH`, and it belongs to some
other organization, so copying it into this organization's evidence row would
be a cross-tenant leak through the one column §34 exists to protect. The count
records that a wrong tag was there; support asks the customer which site they
copied it from.

Never mutate an existing verification check to change historical evidence.

### audit_events

Security-sensitive business actions.

```
id
organization_id
actor_user_id
event_type
entity_type
entity_id
created_at
metadata
```

Examples:

```
organization.created
member.invited
member.role_changed
ai_system.created
deployment.created
disclosure.published
report.generated
billing.plan_changed
```

Audit logs should not contain passwords, tokens, raw payment data, authentication headers, or unnecessary personal information.

---

## 7. Tenant Isolation

Tenant isolation is a non-negotiable invariant.

Every organization-owned table must include:

```sql
organization_id uuid not null
```

Every authenticated query must be scoped by organization.

Bad:

```ts
const deployment = await getDeployment(id);
```

Good:

```ts
const deployment = await getDeployment({
  organizationId,
  deploymentId: id,
});
```

Authorization must happen server-side.

Never trust:

```
organizationId
userId
role
price
plan
permissions
```

when supplied by the browser.

The authenticated session determines the user.

The database determines membership.

Membership determines authorization.

---

## 8. Row-Level Security

Enable PostgreSQL Row Level Security for every user-accessible tenant table.

RLS is defense in depth.

Application-level authorization is still required.

Never treat RLS as a substitute for clear server-side authorization.

Tests must explicitly verify:

```
User A cannot read Organization B.
User A cannot update Organization B.
User A cannot enumerate Organization B IDs.
User A cannot generate reports for Organization B.
User A cannot access Organization B through API routes.
```

A tenant-isolation regression blocks release.

---

## 9. Authentication

Authentication is handled by Supabase Auth.

Supported initially:

```
magic link
Google OAuth
```

Avoid passwords in MVP unless required.

All authenticated server operations must use a trusted server-side session lookup.

Never accept a `userId` from a request and treat it as identity.

---

## 10. Authorization

Use explicit permission helpers.

Example:

```ts
await requireOrganizationRole({
  organizationId,
  minimumRole: "admin",
});
```

Prefer central authorization functions over scattered conditionals.

Roles:

```
owner
  everything

admin
  manage systems
  manage deployments
  manage disclosures
  manage members except owner
  generate reports

member
  manage systems
  manage deployments
  manage disclosures
  generate reports

viewer
  read-only access
```

Billing and ownership transfer should require `owner`.

---

## 11. Public Widget

**The dashboard generates this for you.** Open a deployment and its Install
section has the exact tag, already carrying that deployment's public
identifier and this installation's host, with the Content Security Policy
entries beside it and a plain statement of whether it would render anything
today (TASK-021). What follows is the same installation, explained.

Example installation:

```html
<script
  async
  src="https://your-article50-host/widget.js"
  data-deployment="dep_7k2m4qphr6vt3wzc5nxa7jd2fb"
></script>
```

`widget.js` is served from the application's own origin — the host you sign
in to — not a separate CDN domain (owner, 2026-09-26). One host to allow, and
the widget finds the configuration endpoint from its own script URL, so
nothing else is configured.

The notice renders where the script tag is. To put it somewhere else, name a
container:

```html
<script
  async
  src="https://your-article50-host/widget.js"
  data-deployment="dep_7k2m4qphr6vt3wzc5nxa7jd2fb"
  data-target="#site-footer"
></script>
```

A script in `<head>` has no place on the page, so `data-target` is required
there; the widget says so in the console rather than guessing a corner.

The notice lives in an open shadow root: the page's CSS cannot reach it and
its CSS cannot reach the page. Theme it with custom properties, or reach the
paragraph with `::part(notice)`:

```css
[data-article50] {
  --article50-color: #111;
  --article50-background: #fafafa;
  --article50-border: 1px solid #ddd;
  --article50-border-radius: 6px;
  --article50-padding: 8px 12px;
  --article50-font-family: inherit;
  --article50-font-size: 0.875rem;
}
```

If your site sends a Content Security Policy, add the Article50.js host to
your existing `script-src` and `connect-src` directives — one to load the
script, one to let it fetch the notice. A site that sends a policy already
has those directives, so this is a host to add, not two lines to paste.

It needs no `style-src` exception: its styles go in through a constructable
stylesheet rather than an inline `<style>`, and no element carries a `style`
attribute.

Serve `widget.js` from the Article50.js host, not a copy on your own. The
script asks its own origin for the notice, so a copy asks your server and is
answered by your 404 page. It says so in the console rather than rendering
nothing in silence, but it cannot show the notice.

Use one classic script tag per deployment. `type="module"` is not supported:
the browser hides which script is running from the script itself, and with
two module installs on one page the notice would be rendered against the
wrong tag.

**Subresource Integrity is deliberately not supported.** `integrity` needs
bytes that never change at a URL, and `/widget.js` is one URL whose contents
are meant to change, so that a fix reaches every installed site within the
hour without anyone editing their page. Those two cannot both be true here,
and the fix path was chosen. A customer who adds `integrity` today gets a
CORS error rather than a silent failure later, which is the better failure,
but they lose their notice — so do not add it. Read the script instead: it
ships unminified, uncompiled and commented, exactly as it is in the
repository.

Never expose:

```
database IDs where unnecessary
organization secrets
internal tokens
Supabase service credentials
private customer metadata
```

Use a random public deployment identifier. The database issues one per
deployment: `dep_` and 26 characters of lowercase base32, about 130 random
bits. It is fixed for that deployment's life, it names what to render, and
it is never authorization.

Example:

```
dep_7k2m4qphr6vt3wzc5nxa7jd2fb
```

### The public configuration endpoint

```
GET /api/public/disclosure/{deploymentId}
```

It returns only the information required to render the disclosure.

Example:

```json
{
  "version": 3,
  "language": "en",
  "message": "You are interacting with an AI system."
}
```

No database identifier, organization, AI system, hostname, timestamp or
author is returned, and no key beyond these three.

A "learn more" link is planned and is **not** returned today: no column
stores one and no screen can set one, so it would be an always-null key and
a dead branch in the widget. It arrives with the column, the editor field
and the widget's link together.

Anything else is:

```
404 {"error":{"code":"disclosure_not_found"}}
```

— for every reason alike: an identifier that names no deployment, an
archived deployment, an archived AI system, a closed organization, a system
that has never published, and a notice that has been withdrawn. The endpoint
does not say which, and so cannot be used to discover which deployments
exist.

An identifier of the wrong shape is refused before anything is looked up:

```
400 {"error":{"code":"invalid_deployment_id"}}
```

so a mistyped or wrong-cased identifier is visibly wrong rather than
silently empty.

Caching and access:

```
Cache-Control: public, max-age=0, s-maxage=60, stale-while-revalidate=300
Access-Control-Allow-Origin: *
```

A published, corrected or withdrawn notice reaches visitors within about a
minute. Reading it from any origin is deliberate — the notice is meant for
everyone who visits the customer's site — and is not authorization. The
endpoint is rate limited per network; a refusal is `429`.

---

## 12. Widget Security Requirements

`widget.js` must:

- have no access to private APIs
- contain no secret
- avoid `eval()`
- avoid `new Function()`
- avoid `document.write()`
- avoid inline event handlers
- avoid arbitrary remote code loading
- avoid collecting unnecessary user data
- avoid cookies by default
- avoid localStorage unless justified
- avoid fingerprinting
- avoid analytics by default

The widget must gracefully fail without breaking the customer's site.

All CSS should be scoped.

The widget should not overwrite global variables.

Prefer Shadow DOM if styling conflicts become a real problem.

The widget should remain small.

Target:

```
< 10 KB compressed
```

---

## 13. Content Security Policy

Use a restrictive CSP.

Start from:

```
default-src 'self'
script-src 'self'
style-src 'self' 'unsafe-inline'
img-src 'self' data:
connect-src 'self'
frame-ancestors 'none'
base-uri 'self'
form-action 'self'
object-src 'none'
```

Relax individual directives only where necessary.

Do not blindly copy CSP configuration from third-party examples.

---

## 14. Input Validation

Every external boundary must validate input.

External boundaries include:

```
forms
API routes
server actions
webhooks
cron inputs
URL parameters
query parameters
environment variables
third-party APIs
database JSON fields
```

Use Zod.

Example:

```ts
import { z } from "zod";

export const createDeploymentSchema = z.object({
  aiSystemId: z.string().uuid(),
  hostname: z.string().trim().toLowerCase().min(1).max(253),
});
```

Never rely only on TypeScript types for runtime validation.

---

## 15. Environment Variables

Validate environment variables at startup.

Example:

```ts
const envSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url(),

  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),

  CRON_SECRET: z.string().min(32),

  SENTRY_DSN: z.string().url().optional(),
});
```

Never access `process.env` throughout business code.

Use one validated environment module.

---

## 16. Secret Handling

Secrets must never appear in:

```
client-side bundles
logs
error messages
URLs
analytics
screenshots
test snapshots
Git history
AI-agent handoff files
```

Service-role database credentials may only execute in trusted server environments.

Never prefix secrets with:

```
NEXT_PUBLIC_
```

---

## 17. SSRF Protection

The deployment verifier fetches customer websites.

That makes SSRF protection mandatory.

The verifier must reject:

```
localhost
127.0.0.0/8
0.0.0.0
::1
private IPv4 ranges
link-local ranges
private IPv6 ranges
cloud metadata endpoints
non-http protocols
embedded credentials
unexpected ports
```

Do not trust DNS resolution only once.

Protect against DNS rebinding.

Only allow:

```
https:
http:
```

Prefer HTTPS.

Set:

```
short connection timeout
short total timeout
response-size limit
redirect limit
```

Revalidate redirect targets.

Never allow verification requests to access internal infrastructure.

### What the verifier actually does

Settled in TASK-023 (owner, 2026-09-27). Each of these is a fact a customer
may be told, so it is written here rather than only in the code.

**The scheme.** A deployment is stored as a bare hostname, so the verifier
chooses. It tries `https://` first, and if the connection or the TLS handshake
fails it tries `http://` once. A customer served over plain HTTP has the same
disclosure obligation as everyone else, and refusing to look would record a
failure that is really about their certificate. Evidence fetched over plain
HTTP is weaker — an attacker on the path could have written the page that was
seen — so the scheme that answered, and whether HTTPS failed first, are part
of the stored row rather than an implementation detail.

**The bounds.** Five seconds to connect, fifteen seconds in total for the
whole attempt including any redirects and any HTTPS attempt, one mebibyte of
body, five redirects. Each has its own failure code (§19). They are module
constants, not options: a caller that could widen them could widen them for a
hostile target.

**The size cap refuses; it never truncates.** A body over the cap is
`RESPONSE_TOO_LARGE` and is not inspected. Inspecting a cut-off page would
report `WIDGET_NOT_FOUND` for a page that may well contain the widget, which
is false evidence in the one table whose value is that it can be relied on.

**DNS is resolved once per connection, and the address validated is the
address connected to.** The verifier hands the socket a single address that
passed the public-address rules; there is no second resolution between the
check and the connection, which is what DNS rebinding needs.

**A redirect may go to any public host, but never from HTTPS to HTTP.** Every
hop is revalidated as if it were the original target. Cross-host hops are
ordinary — apex to www, a CDN, a country site — and a hop may carry a path,
which the original target may not. A downgrade is refused: an honest site
never needs one, and it is exactly the step that turns a checked page into one
an attacker on the path can write.

**The verifier names itself.** Requests carry a `User-Agent` of
`Article50Verifier/1.0` and the application's URL, so a customer reading their
access log can tell what the traffic is and allow it deliberately.

**A refused redirect says which rule refused it.** `REDIRECT_BLOCKED` is one
stored code over six causes that each need a different fix, so the rule is
recorded in `metadata.redirect_reason` (§6). §19 governs `failure_code`; the
detail belongs beside it rather than multiplying the code list.

**The fetch has no options.** A caller passes a hostname. The bounds, the
scheme order, the redirect rules and the address rules are not parameters, and
the test seams that exist for exercising the transport live in a module an
ESLint rule keeps out of application code. A fetch whose guard can be replaced
by its caller is not a guard.

**A fault of ours is never recorded as a customer's failure.** If the verifier
cannot even build the request — a hostname that will not parse, an invalid
environment — it raises rather than writing a `failure` row. Both were
validated long before the check ran, so a row would say a customer had not
complied when the truth is that our code is wrong. The scheduler catches per
deployment and records nothing for that one.

---

## 18. Verification

A scheduled job checks active deployments.

Verification should determine:

```
Was the website reachable?
Was Article50.js present?
Was the expected deployment ID present?
Was the expected disclosure version observable?
Was verification successful?
```

Never execute arbitrary JavaScript from customer websites inside the primary application process.

MVP verification should prefer HTML inspection when possible.

Browser-based verification may be added later in an isolated execution environment.

### What HTML inspection can answer, and what it cannot

TASK-023 answers the first question: the fetch, its four bounds, and every
refusal mapped to its own §19 code. TASK-024 answers the second and the third,
and **the fourth is not answerable by HTML inspection at all** (owner,
2026-09-27).

The reason is the widget's own design. A visitor's browser loads
`widget.js`, which asks this installation for the notice and renders it; the
version it renders arrives from our endpoint after a `fetch`, so it is never in
the customer's HTML. `DISCLOSURE_VERSION_MISMATCH` is therefore reserved and
emitted by nothing, and `disclosure_version` is null in every row TASK-024
produces. Resolving the version from our own database was the alternative and
was refused: a success would then assert something the page never showed, and
that column is documented as what was observed, not what was expected. A stale
notice is indistinguishable from a current one until the isolated browser
environment above exists. That is a launch limit, and it is written here rather
than in a handoff because this is the section that asks the question.

**Presence means our own script tag, served from our own host**: a `<script>`
whose `src` resolves to this installation's host and `/widget.js`, carrying
`data-deployment`. The HTML contains nothing else of ours, so the tag is the
observable fact — and it carries both answerable questions in one place. The
path comes from the same constant the dashboard builds the installation from,
so verification cannot end up looking for a path nobody is given.

A tag pointing at a **copy** of `widget.js` on the customer's own domain is not
presence. The widget resolves its configuration endpoint from its own script
URL, so a copy asks the customer's host for a notice, receives their 404, and
renders nothing: the notice really is absent, and a success row would be false
evidence in the direction that matters most. The failure records that this is
what happened, because it is the one fact that says what to change. The scheme,
the query and the fragment are not compared — a protocol-relative tag and a
cache-busting `?v=2` both load our widget — because this is reading an
installation, not authenticating a page.

**A tag a browser would not run is not a tag that was found.** That covers
where the tag sits and whether the element runs, and both halves are load
bearing.

The scan skips comments, doctypes and bogus comments, the raw-text contents of
`script`, `style`, `textarea`, `title`, `xmp`, `iframe`, `noembed` and
`noframes`, the contents of `noscript` (which needs scripting disabled, and our
widget is a script), the contents of `template` (parsed, never executed),
`svg` and `math` subtrees (another namespace, where `script` takes `href` rather
than `src`), everything after `<plaintext>`, and anything inside a tag whose
name the HTML tokenizer extends past `script` — `<script<x …>` is an element
called `script<x`, which nothing runs.

A tag in the right place still has to be one a browser would execute. Following
the specification's "prepare the script element" steps, the element counts when
its `type` is absent, empty, a JavaScript MIME type essence, or `module`, and
when `nomodule` is absent from a classic script. `type="text/plain"` on
otherwise perfect markup fetches nothing, so it is not an installation — and
the failure says so specifically, because the customer's `src` is the one part
they got right.

A body whose `Content-Type` is not an HTML type is not scanned at all, for the
same reason: a browser renders it as something other than a page.

No HTML parser is installed to do this. §56 asks whether platform functionality
can solve a problem before a dependency does, and the dependency here would
exist to be fed hostile bytes from arbitrary websites inside our own process,
to find one element by name. The scanner written instead is a tokenizer, not a
parser, and its limits are listed in its own file.

### The schedule

`GET /api/cron/verify`, authenticated by `CRON_SECRET` in an
`Authorization: Bearer` header and compared in constant time. It is the only
endpoint that acts with the service-role client on nobody's behalf, so it is the
only one whose door is a shared secret.

**A check window is one day** (owner, 2026-09-27). The window length is the
storage policy as much as the schedule: `verification_checks` is never pruned,
and `unique (deployment_id, check_window)` fixes the rate at one row per active
deployment per window. So the evidence supports _checked daily_, not
_continuously monitored_ — a notice can be absent for most of a day before any
row says so. §72 already forbids the stronger claim; this is the weaker one
stated plainly.

**The window is not the tick.** The route is safe to call as often as you like:
a deployment that already has a row for the window is no longer in the queue, so
each tick drains part of it and none of them duplicates anything. Hourly is the
recommended cadence, because one run is bounded — a batch, a concurrency cap,
one in-flight request per hostname, and a wall-clock budget — and whatever it
does not reach stays in the queue for the next one.

**Nothing schedules it in this repository.** There is no `vercel.json` and no
cron entry, deliberately: merging the verifier must not be the act that starts
fetching real customer sites. Add the schedule when verification should begin.

A deployment is checked only when a notice would render for it — active
deployment, active AI system, live organization, current disclosure version, and
that version enabled. That is the same predicate the public endpoint applies,
and it is written once, in SQL, so the set we check and the set we serve cannot
drift apart.

---

## 19. Verification Failure Codes

Use deterministic machine-readable codes.

```
DNS_ERROR
CONNECTION_FAILED
CONNECTION_TIMEOUT
TOTAL_TIMEOUT
HTTP_ERROR
REDIRECT_BLOCKED
TOO_MANY_REDIRECTS
PRIVATE_NETWORK_BLOCKED
RESPONSE_TOO_LARGE
WIDGET_NOT_FOUND
DEPLOYMENT_ID_MISMATCH
DISCLOSURE_VERSION_MISMATCH
UNKNOWN_ERROR
```

This is the stored set (TASK-022), and it differs from the sketch this
section began as in two ways.

`SUCCESS` is **not** among them. `status` already says a check succeeded, and
a second encoding of one fact is a second thing that can be wrong; a stored
code therefore always means a failure, and the database enforces that
`failure_code` is null exactly when `status` is `success`.

`TOTAL_TIMEOUT` and `TOO_MANY_REDIRECTS` are added, because Phase 7 requires
each exceeded bound to map to its own code: a connection that never opened
is a different fact from one that opened and never finished, and a redirect
chain that was too long is a different fact from one that was blocked.

`CONNECTION_FAILED` is added in TASK-023, and it is the only stored code that
is not about a bound. The name resolved and the connection was then refused,
reset, unreachable, or rejected at TLS — a site that is simply down, which is
the most common real failure there is. Without it that lands on
`UNKNOWN_ERROR`, which tells a customer nothing and is what this section
exists to prevent. A failure at TLS specifically is usually invisible,
because the verifier retries once over plain HTTP (§17) and the row records
that HTTPS was tried and failed.

`WIDGET_NOT_FOUND`, `DEPLOYMENT_ID_MISMATCH` and `DISCLOSURE_VERSION_MISMATCH`
are the three an inspection could reach, and TASK-024 emits the first two. It
adds no code to this list — all three were reserved by TASK-022 — but it does
add a `widget_reason` to `metadata`, for the same reason `redirect_reason`
exists: `WIDGET_NOT_FOUND` over "you have no tag", "your tag loads a copy from
your own domain" and "your home page is a PDF" is one stored code over three
different fixes, and this is the failure class a customer must act on. This
section governs `failure_code`; three more codes here would force every
consumer of the list to handle a detail about one of them.

Do not rely on human-readable strings for application logic.

---

## 20. Evidence Integrity

Verification history should be append-only.

For stronger integrity, each verification record may optionally include:

```
payload_hash
previous_record_hash
```

Example conceptual chain:

```
hash(
  deployment_id +
  checked_at +
  result +
  previous_record_hash
)
```

This is not required for MVP launch but the schema should not make future integrity features impossible.

The columns exist as of TASK-022, nullable and unpopulated, each constrained
to 64 lowercase hex characters if present. **Nothing writes them, and
evidence collected before the chain is built is not covered by it** (owner,
2026-09-26; PR #39 review, note 2). The gap is zero today because nothing
writes evidence at all; it starts growing with TASK-025's first scheduled
run. If the chain is built later, there is a permanent before-and-after in
the history, and any report that cites it has to say so rather than imply
the chain proves something about every row.

---

## 21. Evidence Reports

Reports should contain:

```
organization
AI system
deployment
hostname
disclosure version
disclosure text
first verification date
most recent verification date
verification history summary
report generation date
report identifier
```

Reports must say:

> This report documents recorded Article50.js configuration and verification activity. It does not constitute legal advice or certification of regulatory compliance.

Never label the report:

```
Certificate of Compliance
EU AI Act Certification
Official Compliance Certificate
```

unless Article50.js eventually receives an actual recognized certification allowing such terminology.

---

## 22. Stripe

Stripe is the source of truth for payment state.

The application stores only necessary billing references:

```
stripe_customer_id
stripe_subscription_id
subscription_status
price_id
current_period_end
```

Never store card information.

All Stripe webhooks must:

```
verify signatures
be idempotent
handle retries
ignore unknown event types safely
log event IDs
avoid trusting browser-reported payment status
```

---

## 23. Idempotency

Any external event that may retry must be idempotent.

Examples:

```
Stripe webhooks
scheduled verification
report generation requests
invitation acceptance
```

Use stable external event IDs where possible.

---

## 24. Logging

Use structured logging.

Good:

```ts
logger.info(
  {
    organizationId,
    deploymentId,
    checkId,
  },
  "deployment verification completed",
);
```

Bad:

```ts
console.log("check done", deployment);
```

Never log entire request objects.

Never log:

```
authorization headers
cookies
access tokens
refresh tokens
service credentials
full webhook bodies unnecessarily
payment data
```

---

## 25. Error Handling

Expected application failures should use typed/domain errors.

Example:

```ts
class DeploymentNotFoundError extends Error {}

class AuthorizationError extends Error {}

class VerificationBlockedError extends Error {}
```

Client-facing errors must not expose:

```
stack traces
database details
SQL
internal hostnames
secrets
third-party credentials
filesystem paths
```

Production UI:

```
Something went wrong.
Reference: err_8fx29d
```

Detailed context belongs in private telemetry.

---

## 26. TypeScript Rules

`tsconfig.json` must use strict mode.

Recommended:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true
  }
}
```

Avoid:

```
any
as unknown as X
// @ts-ignore
non-null assertions !
```

Exceptions require justification.

Prefer:

```
unknown
```

followed by validation.

---

## 27. Function Design

Prefer small functions.

Good:

```
normalizeHostname()
validateVerificationTarget()
resolveDeployment()
createVerificationRecord()
```

Avoid:

```
handleEverything()
processStuff()
utils.ts
helpers.ts
```

Names should reveal intent.

A reader should not need to inspect implementation to understand what a function is expected to do.

---

## 28. File Design

Prefer feature-local code.

Example:

```
features/deployments/
├── actions/
├── components/
├── queries/
├── schemas/
├── services/
└── types.ts
```

Avoid giant cross-project files such as:

```
lib/utils.ts
lib/api.ts
lib/database.ts
```

when responsibilities become unrelated.

---

## 29. Comments

Comments should explain why, not narrate what.

Bad:

```ts
// Increment count by one
count++;
```

Good:

```ts
// Stripe may deliver the same event more than once,
// so insertion must use the event ID as an idempotency key.
```

---

## 30. Naming

Use:

```
camelCase        variables/functions
PascalCase       React components/types/classes
UPPER_SNAKE_CASE true constants
kebab-case       route segments and ordinary filenames
```

Boolean names should read naturally:

```
isEnabled
hasPermission
canManageBilling
shouldRetry
```

---

## 31. API Design

API routes should follow:

```
authenticate
authorize
validate
execute
serialize
```

Never mix those concerns unpredictably.

Example:

```ts
export async function POST(request: Request) {
  const session = await requireSession();

  const body = createDeploymentSchema.parse(await request.json());

  await requireOrganizationRole({
    userId: session.user.id,
    organizationId: body.organizationId,
    minimumRole: "member",
  });

  const deployment = await createDeployment({
    organizationId: body.organizationId,
    aiSystemId: body.aiSystemId,
    hostname: body.hostname,
  });

  return Response.json({ deployment });
}
```

The real implementation should avoid accepting `organizationId` from the client where it can instead be derived from the authenticated route/context.

### Paging

Two endpoints return a page of history, and both work the same way (TASK-018a,
TASK-026; PR #34 review, note 3). The rule is written here because a caller
cannot infer it from a response:

```
GET …/ai-systems/{id}/disclosures?before={version}
GET …/deployments/{id}/verification-checks?before={checkWindow}
```

- A page holds at most **200** rows, newest first. The same 200 everywhere, so a
  reader who follows a link gets the rows the endpoint would give them.
- `truncated: true` means more rows exist below the last one in the page.
  **No cursor is returned.** Ask again with the last row's own key — its
  `version` for a disclosure, its `checkWindow` for a verification check — as
  `before`. The cursor is a key the rows already carry, so the response does not
  repeat it.
- `before` is exclusive: the row it names is not in the page, so following a
  cursor cannot repeat a row.
- Each cursor is a value that is unique within what is being paged — a
  disclosure's `version` per AI system, a check's `check_window` per deployment.
  That is deliberate: a cursor that could tie would let a page boundary skip a
  row.
- A cursor that is not well formed is `400`. A well-formed cursor below every
  row is an empty page, which is the true answer rather than an error.
- `before` given twice is not well formed either: two cursors name two
  different pages, and preferring one of them would answer a question the
  caller did not ask. Every list here refuses a repeated query parameter for
  the same reason.
- There is no way to page toward newer rows. Start again without `before`.

A response never carries a total count. Counting the rows a tenant has is a
second query whose cost grows with the history, for a number no screen needs.

---

## 32. Database Rules

Every migration must:

```
be committed
be deterministic
be reviewable
avoid destructive changes without a migration strategy
include necessary indexes
include foreign keys
include constraints
```

Prefer database constraints for invariants that belong in the database.

Example:

```sql
check (char_length(name) <= 120)
```

Use:

```
NOT NULL
UNIQUE
FOREIGN KEY
CHECK
```

rather than relying entirely on application behavior.

---

## 33. Deletion Strategy

Do not hard-delete compliance evidence casually.

Suggested behavior:

```
organization deletion:
  soft delete organization
  stop active verification
  revoke access
  preserve legally/operationally required evidence according to retention policy

deployment removal:
  archive deployment
  preserve historical verification records
```

**The retention policy for verification evidence is: kept for the life of
the organization, expired never** (owner, 2026-09-26; TASK-022, PR #39
review, note 1). This is the policy, not the absence of one, and it is why
`verification_checks` has no way to delete a row: no role holds `delete`,
no function does, and the append-only trigger's only door is a cascade from
a parent that is already gone. Deleting the organization takes its evidence
with it; nothing else does.

It was settled while the table was empty, on purpose. Any other answer needs
a door in an append-only trigger, and deciding that later — under storage
pressure, against a table that already holds evidence customers were told
was append-only — is the worst condition to decide it under. Storage grows
by one row per active deployment per window, and the window size TASK-025
chooses is what fixes that rate.

---

## 34. Privacy

Collect as little personal information as possible.

The public widget should not require tracking users.

Do not add:

```
session replay
advertising trackers
fingerprinting
cross-site identifiers
behavioral analytics
```

to the widget.

Dashboard analytics should also follow data-minimization principles.

### Sign-in rate limits and Cloudflare Turnstile

Sign-in requests are counted to stop abuse. The counters are keyed by an
HMAC of the email address or client network, so the database never holds
either one. A counter row is deleted a day after its window ends.

When sign-in requests across the whole service pass an unusual threshold,
the magic-link form shows a Cloudflare Turnstile challenge. Only then does the
visitor's browser load Cloudflare's script and send it the signals Turnstile
uses to tell people from bots. On an ordinary visit nothing is loaded from
Cloudflare. The server sends Cloudflare the challenge's token to verify it,
never the visitor's IP address or email address. The privacy policy must name
Cloudflare as a processor for this purpose.

---

## 35. Accessibility

Dashboard interfaces should target WCAG 2.2 AA.

Required basics:

```
keyboard navigation
visible focus states
semantic HTML
proper labels
sufficient contrast
screen-reader-compatible errors
no color-only status communication
```

Disclosure widgets must remain readable under zoom and mobile layouts.

---

## 36. Testing Strategy

The minimum test pyramid is:

```
unit
  pure validation
  normalization
  permission logic

integration
  database behavior
  authorization
  RLS
  webhook handling
  verification behavior

E2E
  signup
  organization creation
  system creation
  deployment creation
  disclosure publishing
  report generation
```

---

## 37. Mandatory Security Tests

CI must include tests proving:

```
cross-tenant reads fail
cross-tenant writes fail
viewer writes fail
unauthenticated dashboard requests fail
tampered Stripe webhooks fail
private-network verification targets fail
localhost verification fails
unsafe redirects fail
oversized verification responses fail
invalid environment configuration fails startup
```

---

## 38. Test Naming

Prefer behavior-oriented names.

```ts
it("rejects a deployment belonging to another organization");
```

Not:

```ts
it("test deployment permissions");
```

Tests should explain expected system behavior.

---

## 39. CI Requirements

No pull request may merge unless all pass:

```
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm test:integration
pnpm build
```

Security-sensitive changes should additionally execute:

```
pnpm test:security
```

Production deployment should only originate from a protected branch.

---

## 40. Package Scripts

Recommended:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "vitest run tests/integration",
    "test:security": "vitest run tests/security",
    "test:e2e": "playwright test",
    "ci": "pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build"
  }
}
```

---

## 41. Local Setup

Prerequisites:

```
Node.js 22+
pnpm
Supabase CLI
Git
```

Clone:

```bash
git clone git@github.com:YOUR_ORG/article50.git
cd article50
pnpm install
```

Create environment file:

```bash
cp .env.example .env.local
```

Start Supabase:

```bash
supabase start
```

Apply migrations:

```bash
supabase db reset
```

Run application:

```bash
pnpm dev
```

Verify:

```bash
pnpm ci
```

---

## 42. `.env.example`

```bash
NEXT_PUBLIC_APP_URL=http://localhost:3000

SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_FOUNDER=
STRIPE_PRICE_AGENCY=
STRIPE_PRICE_AGENCY_PRO=

CRON_SECRET=

SENTRY_DSN=
```

Never put real credentials inside `.env.example`.

---

## 43. AI Agent Coordination

AI-assisted development is encouraged.

Uncoordinated AI-assisted development is not.

The repository uses explicit agent roles and handoff contracts to prevent:

```
duplicated work
conflicting migrations
architectural drift
silent security regressions
invented requirements
unreviewed dependencies
large unreadable patches
```

`AGENTS.md` is the authoritative operating contract for coding agents.

---

## 44. Agent Hierarchy

```
                    Orchestrator
                         │
       ┌─────────────────┼─────────────────┐
       │                 │                 │
    Backend           Frontend          Database
       │                 │                 │
       └─────────────────┼─────────────────┘
                         │
                     Testing
                         │
                     Security
                         │
                      Reviewer
```

No implementation agent may declare its own work production-ready.

The final reviewer owns completion status.

Security has veto power over release.

---

## 45. Orchestrator Agent

File:

```
.ai/agents/orchestrator.md
```

Responsibilities:

```
understand the requested outcome
inspect existing architecture
split work into minimal independent tasks
identify file ownership
identify dependency ordering
assign specialist agents
prevent overlapping edits
collect handoffs
trigger review
ensure tests pass
```

The orchestrator should not rewrite working code simply to make it stylistically different.

The orchestrator must maintain the smallest reasonable change set.

---

## 46. Backend Agent

Responsible for:

```
server actions
route handlers
business logic
authorization
validation
external integrations
verification logic
Stripe
```

Must never bypass authorization for convenience.

Must never expose service-role credentials to client code.

---

## 47. Frontend Agent

Responsible for:

```
pages
components
forms
accessibility
loading states
error states
responsive behavior
client-side interaction
```

Frontend code does not define security boundaries.

Client-side role checks exist only for UX.

Server-side code always re-checks authorization.

---

## 48. Database Agent

Responsible for:

```
schema
migrations
indexes
constraints
RLS
database tests
query efficiency
```

Only the database agent should create or modify migrations during a coordinated task unless explicitly delegated.

This prevents conflicting schema changes.

---

## 49. Testing Agent

The testing agent does not merely verify happy paths.

It searches for ways the implementation can fail.

Responsibilities:

```
unit tests
integration tests
tenant-isolation tests
permission tests
failure paths
regressions
boundary conditions
```

A feature without meaningful tests is incomplete.

---

## 50. Security Agent

The security agent approaches every feature adversarially.

Review areas:

```
authorization
authentication
tenant isolation
injection
SSRF
XSS
CSRF
secret exposure
unsafe redirects
webhook spoofing
rate abuse
sensitive logging
dependency risk
unsafe deserialization
IDOR
```

The security agent should attempt to prove the implementation unsafe.

Approval occurs only after reasonable attack paths have been eliminated.

---

## 51. Reviewer Agent

The reviewer should not implement the original feature unless required to fix a blocking issue.

Its role is independent evaluation.

Review:

```
correctness
security
readability
tests
architecture
scope
performance
error handling
documentation
```

The reviewer should reject unnecessary complexity.

---

## 52. Agent Task Contract

Every agent receives a task file.

Example:

```markdown
# TASK-014 — Create Deployment

## Objective

Allow an organization member to register a deployment hostname.

## Allowed files

- features/deployments/**
- app/api/deployments/**
- tests/integration/deployments/**
- tests/security/deployments/**

## Forbidden files

- supabase/migrations/**
- lib/billing/**
- public/widget/**

## Invariants

- user must belong to organization
- viewer cannot create deployment
- hostname must be normalized
- private IP targets must not be accepted
- duplicate hostname/system pair must fail cleanly

## Acceptance criteria

- valid deployment can be created
- unauthorized access returns 403
- invalid hostname returns 400
- duplicate deployment returns deterministic error
- tests pass
```

Agents must not modify forbidden files.

If a change outside scope is necessary, stop and report it to the orchestrator.

---

## 53. Agent Handoff Contract

Every completed agent task ends with:

```markdown
## Handoff

### Summary

Implemented deployment creation with authorization and hostname validation.

### Files changed

- features/deployments/create-deployment.ts
- features/deployments/schema.ts
- tests/integration/deployments/create.test.ts

### Security considerations

- organization derived from authenticated membership
- hostname validated server-side
- private-network hostname rejection delegated to shared validator

### Tests

- valid creation
- unauthorized organization
- viewer permission
- invalid hostname
- duplicate hostname

### Commands run

pnpm typecheck
pnpm lint
pnpm test

### Remaining concerns

None.
```

Never write:

```
Looks good.
Probably works.
Should be fine.
```

Agents must state exactly what they verified.

---

## 54. Agent Conflict Rules

Two agents should not modify the same file concurrently.

The orchestrator owns file assignment.

Shared infrastructure modifications should happen before dependent parallel work.

Schema changes happen before code that relies on the new schema.

The preferred sequence:

```
schema
→ domain logic
→ backend
→ frontend
→ tests
→ security review
→ final review
```

Independent tasks may execute concurrently.

---

## 55. Agent Safety Rules

Coding agents must never:

```
disable tests to make CI pass
weaken TypeScript settings
remove RLS to fix permissions
hardcode secrets
commit credentials
turn off signature verification
use dangerouslySetInnerHTML without documented sanitization
add `any` to silence type errors
swallow errors silently
disable lint rules globally without approval
execute arbitrary customer code
trust browser authorization claims
run destructive database commands against production
invent legal claims
```

---

## 56. Dependency Policy

Adding a dependency requires answering:

```
What problem does it solve?
Can existing platform functionality solve it?
Is it actively maintained?
Does it execute in the browser?
What permissions does it require?
What is its security history?
Does it materially increase bundle size?
```

Avoid dependencies for trivial functions.

Run dependency auditing in CI.

---

## 57. Pull Request Size

Prefer small pull requests.

Ideal:

```
< 400 changed lines
```

This is guidance, not an absolute limit.

Large generated migrations and lockfiles do not count the same way as handwritten application code.

A large architectural change should be decomposed wherever practical.

---

## 58. Git Workflow

Branches:

```
feat/deployment-monitoring
fix/cross-tenant-report-access
security/ssrf-redirect-validation
refactor/verification-service
```

Commit examples:

```
feat: add deployment registration
fix: prevent cross-tenant report access
security: block private verification targets
test: cover Stripe webhook retries
```

---

## 59. Pull Request Template

```markdown
## What changed?

Brief explanation.

## Why?

Business or engineering reason.

## Security impact

Describe authorization, data-access, secret, network, or privacy implications.

## Tests

Describe new and existing tests run.

## Screenshots

If UI changed.

## Checklist

- [ ] Typecheck passes
- [ ] Lint passes
- [ ] Tests pass
- [ ] No secrets added
- [ ] Authorization reviewed
- [ ] Tenant isolation reviewed
- [ ] Error states reviewed
- [ ] Documentation updated
```

---

## 60. Definition of Done

A feature is complete only when:

```
behavior matches requirements
authorization is explicit
runtime input validation exists
tenant isolation is preserved
failure states are handled
tests cover meaningful paths
security review passes
TypeScript passes
lint passes
production build passes
documentation is current
no secrets are exposed
no known critical TODO remains
```

"Works on my machine" is not completion.

---

## 61. Rate Limiting

Apply rate limits to abuse-sensitive endpoints.

Examples:

```
authentication attempts
public configuration endpoint
report generation
invitation endpoints
verification triggers
webhooks where appropriate
```

Rate limiting must not be the only authorization mechanism.

---

## 62. Webhook Security

Every webhook endpoint should:

```
read the raw payload correctly
verify provider signature
reject stale/invalid signatures where supported
validate event schema
process idempotently
log provider event ID
return quickly
```

Do not expose internal exception details to webhook senders.

---

## 63. Security Headers

Production responses should use appropriate headers including:

```
Content-Security-Policy
Strict-Transport-Security
X-Content-Type-Options
Referrer-Policy
Permissions-Policy
```

Use framework-supported mechanisms where possible.

---

## 64. XSS Rules

React escaping should remain enabled.

Avoid:

```
dangerouslySetInnerHTML
```

If absolutely necessary:

```
sanitize first
document why
add security tests
review with security agent
```

Disclosure messages should initially support plain text only.

Do not support arbitrary customer HTML in MVP.

---

## 65. CSRF

Prefer framework primitives and same-site cookies.

State-changing requests must require authenticated sessions and appropriate CSRF protection.

Do not create unauthenticated GET endpoints that mutate state.

---

## 66. Data Exposure

API responses should use explicit serializers.

Bad:

```ts
return Response.json(databaseRow);
```

Prefer:

```ts
return Response.json({
  id: deployment.id,
  hostname: deployment.hostname,
  status: deployment.status,
});
```

Never expose internal columns merely because they exist.

---

## 67. IDs

Internal primary keys:

```
UUID
```

Public identifiers may use prefixed random IDs.

Example:

```
org_...
sys_...
dep_...
rep_...
```

Never treat an unguessable ID as authorization.

---

## 68. Public Transparency Page

Optional route:

```
/transparency/[publicId]
```

It may expose:

```
AI system name
general purpose
disclosure text
organization-selected contact
last configuration update
```

It must not expose:

```
internal verification logs
member information
billing state
private system configuration
security metadata
database identifiers
```

---

## 69. MVP Screens

The first production version needs only:

```
/sign-in
/dashboard
/dashboard/systems
/dashboard/systems/new
/dashboard/systems/[id]
/dashboard/deployments/[id]
/dashboard/settings
/dashboard/billing
```

Avoid building:

```
complex analytics
custom report builders
workflow automation
multi-region infrastructure
AI copilots
policy engines
custom RBAC
native mobile apps
```

before customer demand exists.

---

## 70. MVP Build Order

Recommended implementation order:

1. repository foundation
2. authentication
3. organizations + membership
4. tenant-safe database schema
5. AI systems CRUD
6. deployment CRUD
7. disclosure configuration
8. public widget
9. verification service
10. verification history
11. evidence report
12. Stripe
13. agency UX
14. monitoring
15. production security review

---

## 71. First-Day Scope

A disciplined one-day build should target:

```
authentication
single organization per user
AI system creation
deployment registration
disclosure configuration
working widget script
basic deployment verification
verification history
simple PDF evidence report
basic Stripe checkout
```

Do not attempt every feature in this README on day one.

The architectural rules apply immediately.

The feature surface can remain tiny.

---

## 72. Product Language Rules

Permitted language:

```
helps implement transparency measures
maintains disclosure evidence
monitors deployment configuration
documents transparency configuration
supports Article 50 workflows
```

Avoid claims such as:

```
guarantees EU AI Act compliance
makes you legally compliant
EU-approved
official certification
fully compliant automatically
eliminates legal risk
```

unless independently and legitimately substantiated.

---

## 73. Security Disclosure

Create:

```
SECURITY.md
```

Include:

```
supported versions
security contact
responsible disclosure expectations
what information reporters should include
response process
```

Never encourage vulnerability reporters to test against customer accounts or production customer data.

---

## 74. Observability

Track application health rather than user behavior.

Useful metrics:

```
verification success rate
verification latency
widget configuration errors
Stripe webhook failures
report generation failures
HTTP 5xx rate
database latency
cron success
```

Every scheduled job should produce an observable success/failure result.

Silent failure is unacceptable.

---

## 75. Production Readiness Gate

Before accepting paying customers verify:

```
RLS enabled
tenant-isolation tests passing
Stripe webhook validation working
SSRF protection tested
production CSP enabled
security headers enabled
error tracking enabled
database backups configured
migration procedure documented
cron authentication enabled
rate limiting enabled
secrets stored securely
production logs scrubbed
billing cancellation works
data deletion process documented
privacy policy published
terms published
legal claims reviewed
```

---

## 76. Core Engineering Rule

When choosing between:

```
short clever implementation
```

and

```
slightly longer obvious implementation
```

choose the obvious implementation.

When choosing between:

```
implicit convention
```

and

```
explicit invariant
```

choose the explicit invariant.

When choosing between:

```
shipping a feature
```

and

```
breaking tenant isolation
```

do not ship.

---

## 77. Agent System Prompt

The following can be used as the base instruction for repository coding agents:

> You are contributing to Article50.js.
>
> Your priorities, in order:
>
> 1. Preserve security.
> 2. Preserve tenant isolation.
> 3. Preserve correctness.
> 4. Produce readable code.
> 5. Keep scope minimal.
> 6. Preserve test coverage.
> 7. Avoid unnecessary dependencies and abstractions.
>
> Before modifying code:
>
> - read README.md
> - read AGENTS.md
> - inspect relevant existing implementation
> - inspect relevant tests
> - understand authorization boundaries
>
> Never assume client-provided identity, organization membership, role, billing status, or permissions are trustworthy.
>
> Validate all external input at runtime.
>
> Never expose secrets.
>
> Never weaken tests, linting, TypeScript, RLS, CSP, validation, authorization, or security controls merely to make a feature work.
>
> Do not perform unrelated refactors.
>
> Do not create abstractions without a demonstrated need.
>
> If your assigned task requires modifying files outside your allowed scope, report the dependency rather than silently expanding scope.
>
> Before handoff:
>
> - run typecheck
> - run lint
> - run relevant tests
> - review the diff
> - inspect for secret leakage
> - inspect authorization
> - inspect tenant boundaries
> - report exactly what was verified
>
> Security-sensitive uncertainty must be surfaced explicitly.

---

## 78. Orchestrator Prompt

> Act as the engineering orchestrator for Article50.js.
>
> Break requested work into the smallest independently reviewable tasks.
>
> For every task specify:
>
> - objective
> - owner agent
> - allowed files
> - forbidden files
> - dependencies
> - security invariants
> - acceptance criteria
> - required tests
>
> Prevent concurrent agents from editing the same files.
>
> Sequence database changes before dependent application changes.
>
> After implementation, assign independent testing and security review.
>
> Do not accept an implementation agent's own claim that its feature is production-ready.
>
> Require objective verification.
>
> Prefer minimal patches.
>
> Do not allow opportunistic refactoring unrelated to the requested outcome.

---

## 79. Security Reviewer Prompt

> Review the proposed Article50.js change adversarially.
>
> Assume attackers can:
>
> - manipulate every browser request
> - guess or obtain valid resource IDs
> - belong to another tenant
> - replay requests
> - forge unverified webhook payloads
> - provide malicious URLs
> - provide malformed input
> - intentionally trigger edge cases
>
> Inspect specifically for:
>
> - broken authorization
> - IDOR
> - tenant isolation failure
> - SSRF
> - XSS
> - CSRF
> - injection
> - secret exposure
> - unsafe redirects
> - improper error disclosure
> - race conditions
> - webhook spoofing
> - missing idempotency
> - sensitive logging
>
> Do not approve based on style or happy-path functionality.
>
> Provide:
>
> 1. blocking issues
> 2. non-blocking issues
> 3. attack scenarios tested mentally or automatically
> 4. tests that should exist
> 5. final verdict
>
> Verdict must be one of:
>
> ```
> APPROVE
> APPROVE WITH NON-BLOCKING NOTES
> REJECT
> ```

---

## 80. Final Review Prompt

> Perform final engineering review.
>
> Confirm:
>
> - requested behavior exists
> - no unrelated scope was introduced
> - authorization is server-side
> - tenant isolation is preserved
> - external input is validated
> - tests cover important failure paths
> - errors are safe
> - code is readable
> - names communicate intent
> - abstractions are justified
> - no secrets are exposed
> - CI passes
>
> Reject code that merely appears functional but lacks security, testability, or maintainability.
>
> Prefer deletion over unnecessary complexity.

---

## 81. Philosophy

Article50.js should remain unusually simple internally.

The business advantage is not architectural complexity.

The business advantage is:

```
regulatory timing
distribution
agency leverage
excellent UX
reliable evidence
trust
```

The software should therefore optimize for being:

```
safe
boring
fast
predictable
auditable
easy to change
```

That is the engineering standard for this repository.
