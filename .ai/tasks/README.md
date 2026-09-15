# Tasks

One file per task: `TASK-<number>-<kebab-case-slug>.md`.

The orchestrator writes task files. Implementation agents read them and do not
modify files outside `## Allowed files`. If a task genuinely requires a change
outside its scope, stop and report the dependency to the orchestrator rather
than widening the change.

## Template

```markdown
# TASK-014 — Create Deployment

## Objective

Allow an organization member to register a deployment hostname.

## Owner agent

Backend

## Dependencies

TASK-011 (deployments schema + RLS) must be merged first.

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

## Required tests

- integration: create, duplicate, cross-tenant read
- security: cross-tenant write, viewer write, private-network hostname
```
