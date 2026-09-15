# Security Policy

Article50.js records AI transparency configuration and verification evidence for
other people's production websites. A vulnerability here can expose one
customer's evidence to another, so security reports are treated as urgent.

## Supported versions

Article50.js is a hosted service. Only the currently deployed production
version is supported. There are no maintained legacy branches, and fixes are
rolled forward rather than backported.

| Version                       | Supported |
| ----------------------------- | --------- |
| Current production deployment | Yes       |
| Anything else                 | No        |

## Reporting a vulnerability

Email **security@article50.dev** with the details below. If you need
confidentiality, say so in your first message and we will arrange an encrypted
channel before you send details.

Please do not open a public GitHub issue for a security report.

## What to include

- a description of the issue and why you believe it is a security problem
- the affected component, endpoint, or page
- reproduction steps, with the minimum requests or inputs needed
- what an attacker gains: data read, data written, privilege obtained
- any proof-of-concept code, logs, or screenshots, with secrets redacted
- how you would like to be credited, if at all

## Scope and testing rules

Test only against accounts and data you own. Specifically:

- **Do not** test against other customers' accounts, organizations, or data.
- **Do not** test against customer websites monitored by the service.
- **Do not** run denial-of-service, load, or spam tests.
- **Do not** use social engineering, physical access, or attacks on staff.
- **Do not** access, modify, download, or retain data that is not yours. If you
  encounter other customers' data, stop, do not save it, and tell us in the
  report.

Use a test organization you created. If reproducing an issue appears to require
another tenant's data, describe the attack instead of executing it, and we will
reproduce it internally.

## Our response process

1. **Acknowledgement** within 3 business days.
2. **Triage and severity assessment** within 7 business days, with our
   assessment shared back to you.
3. **Status updates** at least every 10 business days while the issue is open.
4. **Fix and deployment.** Critical issues are prioritized over all other work.
   Customers affected by a confirmed breach are notified as required.
5. **Disclosure.** We coordinate public disclosure with you after a fix ships,
   and credit reporters who want it.

Reports made in good faith under these rules will not lead to legal action from
us.
