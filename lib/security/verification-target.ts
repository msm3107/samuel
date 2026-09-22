import "server-only";

import { BlockList, isIPv4, isIPv6 } from "node:net";

/**
 * The one check on where the verifier may go (TASK-012; README §17). A
 * deployment's hostname passes here before it is stored, and Phase 7 extends
 * this module (resolve-time checks, redirect revalidation) rather than adding
 * a second validator.
 *
 * Nothing here touches the network: a registration is judged on the name and
 * IP literals alone, and the verifier checks every address it resolves with
 * `isPublicAddress` at fetch time (owner's decision, 2026-09-22).
 */

/** Deterministic reasons for a refusal; logic branches on these, never on text. */
export const VERIFICATION_TARGET_FAILURES = [
  "INVALID_TARGET",
  "UNSUPPORTED_SCHEME",
  "EMBEDDED_CREDENTIALS",
  "PRIVATE_NETWORK_BLOCKED",
  "IP_ADDRESS_NOT_ALLOWED",
  "PORT_NOT_ALLOWED",
  "PATH_NOT_ALLOWED",
] as const;

export type VerificationTargetFailure =
  (typeof VERIFICATION_TARGET_FAILURES)[number];

export type VerificationTargetResult =
  | { ok: true; hostname: string }
  | { ok: false; code: VerificationTargetFailure };

/** Longer than any valid target (a 253-character name with scheme, port and slash). */
const MAX_INPUT_LENGTH = 1024;

const MAX_HOSTNAME_LENGTH = 253;

/**
 * The shape `deployments.hostname` accepts (the TASK-011 CHECK): lowercase
 * ASCII labels of 1 to 63 characters, at least two, the last starting with a
 * letter. The database keeps its copy as the backstop; this one decides which
 * failure code a person sees.
 */
const HOSTNAME_SHAPE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LAST_LABEL_STARTS_WITH_LETTER = /\.[a-z][a-z0-9-]*$/;

/**
 * Top-level names that only internal resolvers answer (owner's decision,
 * 2026-09-22): IANA's special-use names (RFC 6761, 6762, 7686, 8375, 9476),
 * `.internal`, which ICANN reserves for private use, and names ICANN will
 * never delegate because private networks already use them.
 */
const RESERVED_TOP_LEVEL_NAMES = new Set([
  "localhost",
  "local",
  "internal",
  "arpa",
  "test",
  "invalid",
  "example",
  "onion",
  "alt",
  "home",
  "corp",
  "mail",
  "lan",
]);

/**
 * Whitespace, controls and invisible format characters. The URL parser
 * would drop some of them silently (`ex\u200bample.com` becomes
 * `example.com`), so a person could register a name other than the one they
 * saw. Refused instead.
 */
const HIDDEN_CHARACTERS = /[\s\p{Cc}\p{Cf}]/u;

/** A leading `scheme:` that is not `host:port`. */
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i;

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * Addresses no customer website is served from: everything IANA's
 * special-purpose registries mark as not globally reachable, plus
 * documentation, multicast and reserved space. Cloud metadata endpoints fall
 * inside (169.254.169.254 and fd00:ec2::254 are link-local and unique-local;
 * Alibaba's 100.100.100.200 is shared address space; Oracle's 192.0.0.192 is
 * IETF protocol space).
 *
 * Two lists, because a `BlockList` also checks an IPv4 address against its
 * IPv6 rules, where `::/3` would match every one.
 */
const BLOCKED_IPV4 = (() => {
  const list = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8], // "this network"
    ["10.0.0.0", 8], // private
    ["100.64.0.0", 10], // shared address space (carrier-grade NAT)
    ["127.0.0.0", 8], // loopback
    ["169.254.0.0", 16], // link-local
    ["172.16.0.0", 12], // private
    ["192.0.0.0", 24], // IETF protocol assignments
    ["192.0.2.0", 24], // documentation
    ["192.88.99.0", 24], // 6to4 relay anycast (deprecated)
    ["192.168.0.0", 16], // private
    ["198.18.0.0", 15], // benchmarking
    ["198.51.100.0", 24], // documentation
    ["203.0.113.0", 24], // documentation
    ["224.0.0.0", 4], // multicast
    ["240.0.0.0", 4], // reserved, and broadcast
  ] as const) {
    list.addSubnet(network, prefix, "ipv4");
  }
  return list;
})();

const BLOCKED_IPV6 = (() => {
  const list = new BlockList();
  for (const [network, prefix] of [
    // Only global unicast (2000::/3) is ever public. Outside it: the
    // unspecified and loopback addresses, IPv4-mapped and NAT64 space,
    // unique-local, link-local and multicast.
    ["::", 3],
    ["4000::", 2],
    ["8000::", 1],
    // Inside it, the special-purpose blocks.
    ["2001::", 23], // IETF protocol assignments, Teredo included
    ["2001:db8::", 32], // documentation
    ["2002::", 16], // 6to4, which embeds any IPv4 address
    ["3fff::", 20], // documentation
  ] as const) {
    list.addSubnet(network, prefix, "ipv6");
  }
  return list;
})();

/**
 * Whether the verifier may connect to this address: a public unicast IPv4 or
 * IPv6 address, as `dns.lookup` returns them. Anything it cannot read as one
 * is not public.
 */
export function isPublicAddress(address: string): boolean {
  if (isIPv4(address)) {
    return !BLOCKED_IPV4.check(address, "ipv4");
  }
  if (!isIPv6(address)) {
    return false;
  }
  // A zone index (fe80::1%eth0) names a local interface; link-local is
  // blocked whatever it says.
  const bare = address.split("%")[0] ?? "";
  // An IPv4-mapped address is that IPv4 host, whether written
  // `::ffff:8.8.8.8` or, as the URL parser writes it, `::ffff:808:808`.
  const mapped = mappedIPv4(bare);
  if (mapped !== null) {
    return isPublicAddress(mapped);
  }
  return !BLOCKED_IPV6.check(bare, "ipv6");
}

/**
 * The IPv4 address inside an IPv4-mapped IPv6 address, or null. The URL
 * parser writes every spelling (`::ffff:8.8.8.8`, `0:0:0:0:0:ffff:808:808`)
 * one way, `[::ffff:808:808]`, so one pattern reads them all.
 */
function mappedIPv4(address: string): string | null {
  const host = parse(`http://[${address}]/`)?.hostname ?? "";
  const groups = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(host);
  if (groups === null) {
    return null;
  }
  const high = Number.parseInt(groups[1] ?? "", 16);
  const low = Number.parseInt(groups[2] ?? "", 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/**
 * The canonical form of a hostname, for storing and comparing: lowercase,
 * internationalized labels punycode-encoded (`bücher.de` becomes
 * `xn--bcher-kva.de`), one trailing dot removed, within DNS's length limits.
 * Null for anything that is not a well-formed name: IP addresses, single
 * labels, and input carrying a scheme, credentials, port or path.
 *
 * This says nothing about safety; `validateVerificationTarget` does.
 */
export function normalizeHostname(input: string): string | null {
  if (
    input.length === 0 ||
    input.length > MAX_INPUT_LENGTH ||
    HIDDEN_CHARACTERS.test(input) ||
    /[/?#@:\\[\]%]/.test(input)
  ) {
    return null;
  }
  const url = parse(`https://${input}`);
  if (url === null) {
    return null;
  }
  return nameShape(url.hostname);
}

/**
 * Whether a person may register this as a deployment, and the hostname to
 * store if so. Accepts a bare hostname or an http(s) URL of a whole site
 * (`https://shop.example.com/`), and refuses, with one code each:
 *
 * - a scheme other than http or https: `UNSUPPORTED_SCHEME`;
 * - a user name or password: `EMBEDDED_CREDENTIALS`;
 * - loopback, private, link-local, metadata or other non-public addresses,
 *   and names only internal resolvers answer (`localhost`, `*.internal`):
 *   `PRIVATE_NETWORK_BLOCKED`;
 * - any other IP address, since a deployment is a name:
 *   `IP_ADDRESS_NOT_ALLOWED`;
 * - a port other than the scheme's default: `PORT_NOT_ALLOWED`;
 * - a path, query or fragment, because the verifier checks the site, not a
 *   page, and dropping it would let the person think that page is checked:
 *   `PATH_NOT_ALLOWED`;
 * - anything else malformed: `INVALID_TARGET`.
 *
 * The checks run in the order scheme, credentials, host (address, reserved
 * name, shape), port, path, so an input with several faults always gets the
 * same code.
 */
export function validateVerificationTarget(
  input: string,
): VerificationTargetResult {
  const text = input.trim();
  if (
    text.length === 0 ||
    text.length > MAX_INPUT_LENGTH ||
    HIDDEN_CHARACTERS.test(text)
  ) {
    return refuse("INVALID_TARGET");
  }

  // A bare IPv6 address (`fd00::1`) would read as a scheme, and one with a
  // zone index (`fe80::1%eth0`) doesn't parse as a URL at all.
  if (isIPv6(text)) {
    return refuse(addressFailure(text));
  }
  const hasScheme = SCHEME_PREFIX.test(text);
  const url = parse(hasScheme ? text : `https://${text}`);
  if (url === null) {
    // `ftp://…` and `javascript:…` parse; a scheme whose URL doesn't is
    // still not http.
    return refuse(
      hasScheme && !/^https?:\/\//i.test(text)
        ? "UNSUPPORTED_SCHEME"
        : "INVALID_TARGET",
    );
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return refuse("UNSUPPORTED_SCHEME");
  }
  if (url.username !== "" || url.password !== "") {
    return refuse("EMBEDDED_CREDENTIALS");
  }

  const host = url.hostname;
  const address = host.startsWith("[") ? host.slice(1, -1) : host;
  if (isIPv4(address) || isIPv6(address)) {
    return refuse(addressFailure(address));
  }
  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  const topLevel = name.slice(name.lastIndexOf(".") + 1);
  if (RESERVED_TOP_LEVEL_NAMES.has(topLevel)) {
    return refuse("PRIVATE_NETWORK_BLOCKED");
  }
  const hostname = nameShape(host);
  if (hostname === null) {
    return refuse("INVALID_TARGET");
  }

  if (url.port !== "") {
    return refuse("PORT_NOT_ALLOWED");
  }
  // The parser keeps an empty `?` or `#` in `href` but not in `search` or
  // `hash`, so compare the whole URL with the bare site.
  if (url.href !== `${url.protocol}//${url.host}/`) {
    return refuse("PATH_NOT_ALLOWED");
  }
  return { ok: true, hostname };
}

/** Every IP address is refused; a non-public one says why. */
function addressFailure(address: string): VerificationTargetFailure {
  return isPublicAddress(address)
    ? "IP_ADDRESS_NOT_ALLOWED"
    : "PRIVATE_NETWORK_BLOCKED";
}

function refuse(code: VerificationTargetFailure): VerificationTargetResult {
  return { ok: false, code };
}

/**
 * The WHATWG URL parser, the one `fetch` uses: it lowercases, applies IDNA
 * (NFC and punycode), decodes percent-escapes in the host, and rewrites every
 * IPv4 spelling (`0x7f.1`, `2130706433`, `127.0.0.0x1`) as dotted decimal, so
 * what is judged here is what the verifier would connect to.
 */
function parse(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/** A parsed host as a storable name, or null if it doesn't have the shape. */
function nameShape(host: string): string | null {
  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  if (
    name.length > MAX_HOSTNAME_LENGTH ||
    !HOSTNAME_SHAPE.test(name) ||
    !LAST_LABEL_STARTS_WITH_LETTER.test(name)
  ) {
    return null;
  }
  return name;
}
