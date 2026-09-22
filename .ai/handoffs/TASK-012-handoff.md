## Handoff

### Summary

`lib/security/verification-target.ts` exists: the one check on where the
verifier may go. It exports three things:

- `validateVerificationTarget(input)` returns the hostname to store, or one
  of seven codes.
- `normalizeHostname(input)` returns the canonical form of a bare hostname.
- `isPublicAddress(address)` is for Phase 7 to call on every resolved
  address.

Nothing calls the module yet; TASK-013's routes will.

There was no TASK-012 contract, so this task adds one. Four decisions are the
owner's (Mikołaj Smoliniec, 2026-09-22). The implementer proposed seven
more, all accepted on the PR #26 review. Accepted by Mikołaj Smoliniec
(project owner), 2026-09-22.

### Decisions

1. **Hostname or a site URL, no path** (owner). `https://shop.example.com/`
   is accepted, `…/chat` is `PATH_NOT_ALLOWED`: the verifier checks the
   site, and dropping the path would mislead.
2. **Default ports only** (owner). There is no port column to check another
   port with.
3. **No DNS at registration** (owner). The verifier resolves at every check.
   Downside: `127.0.0.1.nip.io` registers, then fails every check.
4. **Internal-only names refused** (owner): `localhost`, `.local`,
   `.internal`, `.arpa`, `.test`, `.invalid`, `.example`, `.onion`, `.alt`,
   `.home`, `.corp`, `.mail` and `.lan`, plus `.localdomain` (PR #26
   review: many hosts files map `localhost.localdomain` to 127.0.0.1).
5. **Seven codes, a fixed order of checks** (accepted). `PRIVATE_NETWORK_BLOCKED`
   is README §19's. A public IP gets `IP_ADDRESS_NOT_ALLOWED`, since calling
   it private would be false.
6. **The WHATWG URL parser only** (accepted), as `fetch` uses it.
   - Every IPv4 spelling (hex, octal, a single number, `127.0.0.0x1`,
     percent-escaped, full-width digits) reaches the check as dotted
     decimal.
   - Rejected: parsing IPs by hand, and adding an address library.
7. **Blocked ranges** (accepted): IANA's not-globally-reachable space plus
   documentation, benchmarking, multicast and reserved.
   - For IPv6, only `2000::/3` is allowed, minus Teredo, 6to4 and
     documentation.
   - IPv4-mapped addresses are judged as their IPv4 address, and NAT64 is
     refused.
   - Two `BlockList`s, because one list checks IPv4 against its IPv6 rules
     too: with `::/3` in a shared list, every IPv4 address came back private
     (caught in testing).
8. **Invisible characters refused, not stripped** (accepted). The URL
   parser silently drops a zero-width space, so `shop\u200b.example.com`
   would store a name the person didn't see.
   - The first version refused only whitespace, controls and format
     characters. The review found five more the parser drops (U+034F,
     U+FE0F, U+180B, U+3164, U+115F). Now each non-ASCII character is put
     to the parser, and refused if it disappears (owner's choice). Rejected:
     listing them, which can miss others.
9. **`normalizeHostname` doesn't judge safety** (accepted). It is for
   storing and comparing. `validateVerificationTarget` adds the safety
   checks and always returns `normalizeHostname`'s form.
10. **`isPublicAddress` exported now** (accepted), so Phase 7 reuses these
    rules instead of writing its own.
11. **Server-only** (accepted), like the rest of `lib/security`.

### Files changed

- `.ai/tasks/TASK-012-verification-target.md` (new): the contract
- `lib/security/verification-target.ts` (new)
- Tests:
  - `tests/security/verification-target/verification-target.test.ts`
    (new): 22 tests, the plan's exit criteria and disguised addresses
  - `tests/unit/security/verification-target.test.ts` (new): 188 tests
  - `tests/integration/database/verification-target.supabase.ts` (new): 18
    tests, real database, the validator and the TASK-011 CHECK agree

### Security considerations

- Loopback, private, link-local, shared (carrier-grade NAT) and metadata
  addresses are refused in every spelling the URL parser accepts. This
  covers the forms TASK-011's review found (`127.0.0.0x1`,
  `169.254.169.0xfe`) and IPv4-mapped IPv6.
- An address the module can't read is not public (fails closed).
- The database CHECK stays the backstop: even a bug here can't store an IP
  literal or `localhost`.
- No secrets, no network calls, no new dependency.

### Tests

- Required by the contract: all covered.
- Mutation checks, each reverted; the unit and security suites caught all
  of them:
  - no reserved-name check: 20 fail
  - no hidden-character check: 6 fail
  - one `BlockList` for both families: 15 fail
  - no credential check: 5 fail
  - no path check: 7 fail
  - no port check: 6 fail
  - no letter-first rule: 4 fail. `shop.example.1abc` is the case only this
    rule catches, since the URL parser refuses all-numeric last labels
    itself.
  - no IPv4-mapped unwrap: 3 fail
  - link-local not blocked: 8 fail
  - `c000::/2` not blocked (unique-local, link-local, multicast): 10 fail
  - 6to4 not blocked: 1 fails
- After the PR #26 review, each also reverted:
  - the parser not asked about dropped characters: 8 fail
  - no `localdomain`: 1 fails

### Commands run

See the PR. Each gate was run with the owner's untracked
`CODEX-SECURITY.md` set aside and restored, and its hash verified.

### Remaining concerns

- **Phase 7 must still resolve and pin.** This module can't see what a name
  resolves to. The verifier must call `isPublicAddress` on the address it
  actually connects to, and again for every redirect.
- **Carried into TASK-014, the verifier and public pages** (TASK-011 review
  finding 2): a deployment of an archived AI system is treated as inactive.
- **Lookalike names (PR #26 review, note 3), for TASK-013's contract.**
  `аpple.com` with a Cyrillic "а" is stored as `xn--pple-43d.com`, which is
  right. Screens must show that punycode form, or both forms, so the name
  can't pass as `apple.com`. The verifier still proves who has the widget.
- **TASK-013 maps these codes to API errors.** The route's 400 should carry
  the code so the form can explain it. It must not echo the input into logs
  beyond what the logging rules allow.
- **Owed from earlier tasks, unchanged:** the database NFC check with the
  next migration on `ai_systems` or `organizations`; the widget's own
  revocable key and direction-isolated rendering.
