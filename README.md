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
http_status
widget_detected
disclosure_version
failure_code
metadata
```

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

Example installation:

```html
<script
  async
  src="https://cdn.article50.dev/widget.js"
  data-deployment="dep_7k2m4qphr6vt3wzc5nxa7jd2fb"
></script>
```

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

---

## 19. Verification Failure Codes

Use deterministic machine-readable codes.

Example:

```
SUCCESS
DNS_ERROR
CONNECTION_TIMEOUT
HTTP_ERROR
REDIRECT_BLOCKED
PRIVATE_NETWORK_BLOCKED
RESPONSE_TOO_LARGE
WIDGET_NOT_FOUND
DEPLOYMENT_ID_MISMATCH
DISCLOSURE_VERSION_MISMATCH
UNKNOWN_ERROR
```

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

Define the actual retention policy before production launch.

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
