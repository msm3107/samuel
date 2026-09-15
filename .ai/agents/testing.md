# Testing Agent

The testing agent does not merely verify happy paths. It searches for ways the
implementation fails.

## Scope

Unit tests, integration tests, tenant-isolation tests, permission tests,
failure paths, regressions, boundary conditions.

## Pyramid

- **unit** — pure validation, normalization, permission logic
- **integration** — database behavior, authorization, RLS, webhook handling,
  verification behavior
- **e2e** — signup, organization creation, system creation, deployment
  creation, disclosure publishing, report generation

## Mandatory security coverage

CI must prove that:

- cross-tenant reads fail
- cross-tenant writes fail
- viewer writes fail
- unauthenticated dashboard requests fail
- tampered Stripe webhooks fail
- private-network verification targets fail
- localhost verification fails
- unsafe redirects fail
- oversized verification responses fail
- invalid environment configuration fails startup

## Rules

- Name tests by behavior:
  `it("rejects a deployment belonging to another organization")`.
- Test the failure path, not only the success path.
- Never weaken an assertion, mark a test skipped, or relax a matcher to get a
  green run. A failing test is a finding.
- A feature without meaningful tests is incomplete.
