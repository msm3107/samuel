# Contributing

Read `AGENTS.md` before your first change. It is the operating contract for the
repository and applies to humans and coding agents alike. `README.md` is the
reference specification.

## Prerequisites

- Node.js 22+ (`.nvmrc` pins the major version)
- pnpm 10+
- Supabase CLI (once the database work lands)
- Git

## Setup

```bash
pnpm install
cp .env.example .env.local   # then fill it in; never commit .env.local
pnpm hooks:install           # pre-commit: format:check && lint
pnpm dev
```

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

Authentication, the database schema, the widget, verification, evidence
reports, and billing are still to come, in the order given in `README.md` §70.
End-to-end tests arrive with the first user-facing flow; Playwright is
deliberately not a dependency until then.
