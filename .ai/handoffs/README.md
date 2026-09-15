# Handoffs

One file per completed task: `TASK-<number>-handoff.md`.

State exactly what was verified. "Looks good", "probably works", and "should be
fine" are not acceptable. Never record a command as passing that was not run —
paste the outcome, not the intention.

Handoff files are committed. They must contain no secrets, tokens, customer
data, or personal information.

## Template

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

pnpm typecheck passed
pnpm lint passed
pnpm test passed (42 tests)

### Remaining concerns

None.
```
