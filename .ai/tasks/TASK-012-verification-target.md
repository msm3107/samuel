# TASK-012 — Verification target validation

## Objective

Add `lib/security/verification-target.ts`, the one module that decides where
the verifier may go (README §17). Before a deployment is stored, it
normalizes the hostname and refuses private, loopback and otherwise unsafe
targets. Phase 7 extends this module with resolve-time checks and redirect
revalidation; it must not grow a second validator (PLAN, Phase 4).

TASK-013 calls it from the deployment routes; this task wires it to nothing.

## Owner agent

Security

## Dependencies

TASK-011 (`deployments.hostname` and its CHECK, which this module's output
must always satisfy).

## Allowed files

- lib/security/verification-target.ts (new)
- tests/unit/security/verification-target.test.ts (new)
- tests/security/verification-target/** (new)
- tests/integration/database/verification-target.supabase.ts (new)

## Forbidden files

- supabase/migrations/**
- app/** and features/**
- lib/** outside the file above

## Decisions

Decided by Mikołaj Smoliniec (project owner), 2026-09-22:

- **A person may enter a hostname or a site URL without a path.**
  `shop.example.com` and `https://shop.example.com/` are both accepted.
  `https://shop.example.com/chat` is refused as `PATH_NOT_ALLOWED`.
  - Why: the verifier checks the site. Silently dropping `/chat` would let
    the person believe that page is monitored.
  - Rejected: dropping the path, which misleads for the same reason. Also
    rejected: a bare hostname only, which fails the common case of pasting a
    URL.
- **Default ports only.** No port, 80 with http, or 443 with https;
  anything else is `PORT_NOT_ALLOWED`.
  - Why: `deployments` has no port column, so the verifier only ever
    fetches the default port, and `:8443` would record a site that is never
    checked.
  - Rejected: any port, which needs a schema change and lets the verifier
    reach admin ports.
- **No DNS lookup at registration.** The module is a pure function of its
  input. The verifier resolves at every check and connects only to an
  address `isPublicAddress` approved (Phase 7).
  - Why: a registration-time answer can't be trusted later, it would refuse
    sites whose DNS isn't live yet, and registration would depend on the
    network.
  - Downside: `127.0.0.1.nip.io` registers, then fails every check.
- **Names only internal resolvers answer are refused up front** as
  `PRIVATE_NETWORK_BLOCKED`. These are the names under `localhost`, `local`,
  `internal`, `arpa`, `test`, `invalid`, `example`, `onion` and `alt`, plus
  ICANN's never-delegated `home`, `corp`, `mail` and `lan`.
  - Rejected: only the public root zone's TLDs, a list that needs updating.
    Also rejected: only `localhost` and `.internal`.
  - Downside: other undelegated names (`.intranet`) pass here and fail at
    resolution in Phase 7.

Proposed by the implementer; all seven accepted on the PR #26 review.
Accepted by Mikołaj Smoliniec (project owner), 2026-09-22.

- **Seven deterministic codes**, in README §19's style:
  - the codes are `INVALID_TARGET`, `UNSUPPORTED_SCHEME`,
    `EMBEDDED_CREDENTIALS`, `PRIVATE_NETWORK_BLOCKED` (README's own),
    `IP_ADDRESS_NOT_ALLOWED`, `PORT_NOT_ALLOWED` and `PATH_NOT_ALLOWED`;
  - a public IP literal gets its own code, because a deployment is a name
    (the TASK-011 CHECK refuses every IP) and "private network" would be
    untrue;
  - checks run in a fixed order (scheme, credentials, host, port, path), so
    an input with several faults always gets the same code.
- **The WHATWG URL parser is the only parser**, the one `fetch` uses.
  - It turns every IPv4 spelling (`0x7f.1`, `2130706433`, `127.0.0.0x1`)
    into dotted decimal, applies IDNA (NFC, then punycode), and decodes
    percent-escapes in the host.
  - So what is judged is what the verifier would connect to.
  - Rejected: a hand-written IP parser (the class of bug TASK-011's review
    finding 1 was), and an address library, a dependency for something Node
    has (`net.BlockList`).
- **Blocked addresses:**
  - every range IANA's special-purpose registries mark as not globally
    reachable, plus documentation, benchmarking, multicast and reserved
    space;
  - for IPv6, only global unicast (`2000::/3`) is allowed, minus its
    special blocks (Teredo, 6to4, documentation);
  - IPv4-mapped addresses are judged as their IPv4 address, and NAT64 is
    refused outright;
  - the cloud metadata addresses fall inside these ranges and are tested by
    name.
- **Invisible characters are refused, not stripped.** The URL parser drops
  zero-width spaces and soft hyphens silently, so `shop\u200b.example.com`
  would register as a name the person didn't see. Controls, whitespace,
  Unicode format characters, and any character the parser drops (amended on
  the PR #26 review) are refused as `INVALID_TARGET`.
- **`normalizeHostname` canonicalizes and nothing more.** It returns the
  storable form of a bare hostname, or null. `validateVerificationTarget`
  adds the safety checks, and its hostname is always
  `normalizeHostname`'s.
- **`isPublicAddress` is exported now** for Phase 7 to call on every
  resolved address, so the address rules live in one place from the start.
- **Server-only**, like the rest of `lib/security`. A form can show its own
  hints; the decision is the server's.

## Amendment: the PR #26 review

Decided by Mikołaj Smoliniec (project owner), 2026-09-22:

- **Every character the URL parser drops is refused** (note 1). IDNA
  ignores some characters outside the classes the first version checked:
  U+034F, variation selectors, and Hangul fillers. Each non-ASCII character
  is now put to the parser itself, and refused if it disappears.
  Rejected: adding those characters to the pattern, a list that can miss
  others. Also rejected: narrowing the promise instead.
- **`localdomain` is reserved** (note 2). Many hosts files map
  `localhost.localdomain` to 127.0.0.1.
- **For TASK-013's contract** (note 3): a lookalike name (`аpple.com` with a
  Cyrillic "а") is stored correctly as `xn--pple-43d.com`. Screens must
  show the punycode form, or both forms, so it can't pass as `apple.com`.

## Invariants

- One validator: Phase 7 extends this module rather than adding another.
- Every hostname the validator approves satisfies the TASK-011 CHECK, and
  every name it calls malformed the CHECK refuses too (tested against the
  real database).
- Nothing in the module touches the network.
- A refusal is one of the seven codes, never free text.

## Acceptance criteria

- `localhost`, `127.0.0.1`, `169.254.169.254`, `[::1]`, a private IPv6
  address, an embedded-credential URL and a non-HTTP scheme are each refused
  with the right code (PLAN, Phase 4 exit criteria).
- Every IPv4 spelling of loopback and the metadata address is refused.
- Hostnames are lowercased, IDN punycode-encoded, one trailing dot removed,
  and length-bounded.
- Typecheck, lint, format, and tests pass.

## Required tests

- security: the exit criteria's targets, and disguised internal addresses
- unit: normalization, each code, the check order, the reserved names, and
  `isPublicAddress` across every blocked range and its edges
- integration (real database): the validator and the CHECK agree in both
  directions
