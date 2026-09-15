# Scripts

Operational entry points. Each script must validate its own inputs and produce
an observable success or failure result — a silent failure in a scheduled job
is a production incident that nobody sees.

Planned, in the order of `README.md` §70:

- `verify-deployments.ts` — the scheduled verifier. Fetches customer sites
  through the SSRF-protected target validator, inspects HTML for the widget and
  the expected deployment identifier, and appends a `verification_checks`
  record per deployment. Authenticated by `CRON_SECRET`.
- `seed.ts` — local development data only. Never runs against production.
