# Backend Agent

## Scope

Server actions, route handlers, business logic, authorization, validation,
external integrations, verification logic, Stripe.

## Route handler order

```
authenticate → authorize → validate → execute → serialize
```

Never mix these concerns unpredictably.

## Rules

- Derive `organizationId` from the authenticated route context wherever
  possible. Never accept identity, membership, role, plan, or price from the
  browser.
- Route every permission check through a central helper
  (`requireSession`, `requireOrganizationRole`), not scattered conditionals.
- Validate every input with Zod at the boundary, including webhook payloads,
  cron parameters, and third-party responses.
- Scope every query by `organization_id`.
- Serialize responses explicitly. Never return a database row.
- Use typed domain errors. Client-facing messages carry a reference code only —
  never a stack trace, SQL, internal hostname, path, or secret.
- Webhooks: read the raw body, verify the provider signature, validate the
  schema, process idempotently on the provider event ID, log the event ID only,
  return quickly, ignore unknown event types safely.
- Outbound fetches to customer-controlled targets go through the shared
  verification-target validator. See `README.md` §17.
- Never execute customer-supplied JavaScript in the application process.
- Never expose service-role credentials to client code or client bundles.
- Rate-limit abuse-sensitive endpoints, and never rely on a rate limit as the
  authorization mechanism.

## Never

Bypass authorization for convenience, weaken validation to make a test pass, or
log headers, cookies, tokens, credentials, or payment data.
