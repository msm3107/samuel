# Contributing

Read `AGENTS.md` before your first change. It is the operating contract for the
repository and applies to humans and coding agents alike. `README.md` is the
reference specification, and `.ai/PLAN.md` is the phase plan — what is being
built next, in what order, and why.

## Prerequisites

- Node.js 22+ (`.nvmrc` pins the major version)
- pnpm 10+
- Docker Desktop (for local Supabase). Turn off Docker AI / Model Runner in
  Settings → AI; its socket has crashed Docker Desktop on Windows.
- Git

## Setup

```bash
pnpm install
pnpm supabase:start                   # local Supabase in Docker (first run pulls images)
node scripts/local-env.mjs --write    # creates .env.local from `supabase status`
pnpm hooks:install                    # pre-commit: format:check && lint
pnpm dev
```

The Supabase CLI is a pinned devDependency, so there is nothing to install
globally. `scripts/local-env.mjs --write` never overwrites an existing
`.env.local`. The keys it writes are Supabase's published local development
keys and reach only the containers on your machine; never put hosted-project
keys in `.env.local` for tests.

Magic-link email is delivered to Mailpit at http://127.0.0.1:54324. Google
sign-in stays disabled locally unless you set
`SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` and
`SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET` and enable the provider in
`supabase/config.toml`; see `.ai/handoffs/TASK-003-handoff.md` for the manual
steps. `pnpm supabase:stop` shuts it all down.

The application refuses to start on invalid configuration. If startup fails
with `InvalidEnvironmentError`, the message names the variables at fault — it
never prints their values.

## Verifying a change

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

`pnpm run ci` runs the sequence in one command — `run` is required, because
`pnpm ci` resolves to pnpm's own reserved command. Run `pnpm test:integration` when
touching the database, authorization, or webhooks, and `pnpm test:security` for
any security-sensitive change.

With local Supabase running:

```bash
pnpm test:supabase        # Vitest suites against the real instance (*.supabase.ts)
pnpm test:e2e             # Playwright against a stub auth server
pnpm test:e2e:supabase    # Playwright against the real instance, reading Mailpit
```

The first run of either e2e script needs `pnpm exec playwright install chromium`.
The `End-to-end` CI workflow runs all three.

Report what you actually ran and what it returned. Do not record a command as
passing that you did not run.

## Branches and commits

```
feat/deployment-monitoring
fix/cross-tenant-report-access
security/ssrf-redirect-validation
refactor/verification-service
```

```
feat: add deployment registration
fix: prevent cross-tenant report access
security: block private verification targets
test: cover Stripe webhook retries
```

Prefer pull requests under roughly 400 changed lines of handwritten code.
Lockfiles and generated migrations do not count the same way.

## What reviewers will block on

- a query not scoped by `organization_id`
- authorization decided on the client, or derived from a browser-supplied value
- an external input reaching business logic without a Zod schema
- a secret in a log, an error message, a URL, a test snapshot, or a commit
- a customer-controlled fetch that skips the verification-target validator
- a mutation of recorded verification evidence
- a weakened test, type setting, lint rule, RLS policy, or CSP directive
- a legal claim the product is not entitled to make (`README.md` §72)

## Not yet built

Authentication is in place (Phase 1). The database schema, the widget,
verification, evidence reports, and billing are still to come. `.ai/PLAN.md`
breaks them into phases with dependencies and exit criteria; `AGENTS.md` §2
lists exactly what exists today.
