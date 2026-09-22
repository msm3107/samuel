import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  isPublicAddress,
  normalizeHostname,
  validateVerificationTarget,
  VERIFICATION_TARGET_FAILURES,
} from "@/lib/security/verification-target";

describe("normalizeHostname", () => {
  it.each([
    ["shop.example.com", "shop.example.com"],
    ["Shop.Example.COM", "shop.example.com"],
    ["shop.example.com.", "shop.example.com"],
    ["bücher.de", "xn--bcher-kva.de"],
    ["BÜCHER.DE", "xn--bcher-kva.de"],
    ["xn--bcher-kva.de", "xn--bcher-kva.de"],
    ["магазин.рф", "xn--80aairftm.xn--p1ai"],
    // Ideographic full stops are dots under IDNA.
    ["shop\u3002example\u3002com", "shop.example.com"],
  ])("canonicalizes %j to %j", (input, expected) => {
    expect(normalizeHostname(input)).toBe(expected);
  });

  it.each([
    ["an empty string", ""],
    ["a single label", "intranet"],
    ["an IPv4 address", "127.0.0.1"],
    ["a hexadecimal IPv4 form", "127.0.0.0x1"],
    ["an IPv6 address", "[::1]"],
    ["a scheme", "https://shop.example.com"],
    ["a port", "shop.example.com:443"],
    ["a path", "shop.example.com/chat"],
    ["credentials", "user@shop.example.com"],
    ["a percent-escape", "shop%2eexample.com"],
    ["an underscore", "shop_1.example.com"],
    ["a label starting with a hyphen", "-shop.example.com"],
    ["an empty label", "shop..example.com"],
    ["two trailing dots", "shop.example.com.."],
    ["a numeric top-level label", "shop.example.123"],
    ["a top-level label starting with a digit", "shop.example.1abc"],
    ["a 64-character label", `${"a".repeat(64)}.com`],
    ["a space", "shop example.com"],
    ["a zero-width space", "shop\u200b.example.com"],
    ["a soft hyphen", "sh\u00adop.example.com"],
    ["a combining grapheme joiner", "sh\u034fop.example.com"],
    ["invalid punycode", "xn--zz.com"],
  ])("refuses %s", (_label, input) => {
    expect(normalizeHostname(input)).toBeNull();
  });

  it("accepts 253 characters and refuses 254", () => {
    const label = "a".repeat(63);
    const name253 = `${label}.${label}.${label}.${"b".repeat(57)}.com`;
    expect(name253).toHaveLength(253);
    expect(normalizeHostname(name253)).toBe(name253);
    expect(normalizeHostname(`a${name253}`)).toBeNull();
  });

  it("does not judge safety", () => {
    expect(normalizeHostname("metadata.google.internal")).toBe(
      "metadata.google.internal",
    );
  });
});

describe("validateVerificationTarget", () => {
  it.each([
    ["shop.example.com", "shop.example.com"],
    ["  Shop.Example.com.  ", "shop.example.com"],
    ["https://shop.example.com", "shop.example.com"],
    ["https://shop.example.com/", "shop.example.com"],
    ["HTTP://SHOP.EXAMPLE.COM/", "shop.example.com"],
    ["http://shop.example.com:80/", "shop.example.com"],
    ["https://shop.example.com:443", "shop.example.com"],
    ["https://bücher.de/", "xn--bcher-kva.de"],
    ["shop.xn--p1ai", "shop.xn--p1ai"],
    // Resolves to 127.0.0.1, but registration doesn't resolve: the verifier
    // refuses it at every check (owner's decision).
    ["127.0.0.1.nip.io", "127.0.0.1.nip.io"],
  ])("accepts %j as %j", (input, hostname) => {
    expect(validateVerificationTarget(input)).toEqual({ ok: true, hostname });
  });

  it.each([
    ["ftp://shop.example.com", "UNSUPPORTED_SCHEME"],
    ["file:///etc/passwd", "UNSUPPORTED_SCHEME"],
    ["file:/etc/passwd", "UNSUPPORTED_SCHEME"],
    ["javascript:alert(1)", "UNSUPPORTED_SCHEME"],
    ["data:text/html,hi", "UNSUPPORTED_SCHEME"],
    ["mailto:someone@example.com", "UNSUPPORTED_SCHEME"],
    ["gopher://shop.example.com:70/", "UNSUPPORTED_SCHEME"],
    ["ws://shop.example.com", "UNSUPPORTED_SCHEME"],
    ["https://user@shop.example.com", "EMBEDDED_CREDENTIALS"],
    ["https://:secret@shop.example.com", "EMBEDDED_CREDENTIALS"],
    ["https://user:secret@127.0.0.1", "EMBEDDED_CREDENTIALS"],
    ["8.8.8.8", "IP_ADDRESS_NOT_ALLOWED"],
    ["https://8.8.8.8/", "IP_ADDRESS_NOT_ALLOWED"],
    ["[2606:4700:4700::1111]", "IP_ADDRESS_NOT_ALLOWED"],
    ["2606:4700:4700::1111", "IP_ADDRESS_NOT_ALLOWED"],
    ["[::ffff:8.8.8.8]", "IP_ADDRESS_NOT_ALLOWED"],
    ["shop.example.com:8080", "PORT_NOT_ALLOWED"],
    ["https://shop.example.com:8443/", "PORT_NOT_ALLOWED"],
    // Only the scheme's own default port.
    ["http://shop.example.com:443", "PORT_NOT_ALLOWED"],
    ["https://shop.example.com:80", "PORT_NOT_ALLOWED"],
    ["https://shop.example.com/chat", "PATH_NOT_ALLOWED"],
    ["shop.example.com/chat", "PATH_NOT_ALLOWED"],
    ["https://shop.example.com/?page=1", "PATH_NOT_ALLOWED"],
    ["https://shop.example.com/?", "PATH_NOT_ALLOWED"],
    ["https://shop.example.com/#top", "PATH_NOT_ALLOWED"],
    ["https://shop.example.com#", "PATH_NOT_ALLOWED"],
    ["", "INVALID_TARGET"],
    ["   ", "INVALID_TARGET"],
    ["intranet", "INVALID_TARGET"],
    ["shop_1.example.com", "INVALID_TARGET"],
    ["shop..example.com", "INVALID_TARGET"],
    ["shop.example.123", "INVALID_TARGET"],
    ["shop.example.1abc", "INVALID_TARGET"],
    [`${"a".repeat(64)}.com`, "INVALID_TARGET"],
    ["://shop.example.com", "INVALID_TARGET"],
    ["https://", "INVALID_TARGET"],
    ["shop\u200b.example.com", "INVALID_TARGET"],
    ["shop\u00ad.example.com", "INVALID_TARGET"],
    ["shop.exa\tmple.com", "INVALID_TARGET"],
    ["shop.exa\nmple.com", "INVALID_TARGET"],
    ["shop\u202e.example.com", "INVALID_TARGET"],
    // Dropped by IDNA without a trace (PR #26 review).
    ["exa\u034fmple.com", "INVALID_TARGET"],
    ["exa\ufe0fmple.com", "INVALID_TARGET"],
    ["exa\u180bmple.com", "INVALID_TARGET"],
    ["exa\u3164mple.com", "INVALID_TARGET"],
    ["exa\u115fmple.com", "INVALID_TARGET"],
    ["exa\ufe00mple.com", "INVALID_TARGET"],
    ["exa\u{e0100}mple.com", "INVALID_TARGET"],
    [`${"a.".repeat(600)}com`, "INVALID_TARGET"],
  ])("refuses %j with %s", (input, code) => {
    expect(validateVerificationTarget(input)).toEqual({ ok: false, code });
  });

  it.each([
    "localhost",
    "LOCALHOST",
    "localhost.",
    "localhost.localdomain",
    "app.localhost",
    "printer.local",
    "metadata.google.internal",
    "instance-data.ec2.internal",
    "router.home.arpa",
    "1.0.0.127.in-addr.arpa",
    "shop.test",
    "shop.invalid",
    "shop.example",
    "hidden.onion",
    "name.alt",
    "nas.home",
    "dc.corp",
    "exchange.mail",
    "router.lan",
  ])("refuses the internal-only name %j as PRIVATE_NETWORK_BLOCKED", (name) => {
    expect(validateVerificationTarget(name)).toEqual({
      ok: false,
      code: "PRIVATE_NETWORK_BLOCKED",
    });
  });

  it.each([
    // The URL parser reads every IPv4 spelling as dotted decimal, as fetch
    // does, so none of these slips through as a name.
    "http://0x7f.1",
    "http://0x7f000001",
    "http://2130706433",
    "http://017700000001",
    "http://127.1",
    "http://127.0.0.0x1",
    "http://169.254.169.0xfe",
    "http://127.0.0.%31",
    "http://[::ffff:7f00:1]",
    "http://[0:0:0:0:0:ffff:127.0.0.1]",
    "http://①②⑦.0.0.1",
  ])("refuses the loopback or metadata spelling %j", (input) => {
    expect(validateVerificationTarget(input)).toEqual({
      ok: false,
      code: "PRIVATE_NETWORK_BLOCKED",
    });
  });

  it("checks in a fixed order, so several faults give one code", () => {
    expect(validateVerificationTarget("ftp://u:p@127.0.0.1:21/x")).toEqual({
      ok: false,
      code: "UNSUPPORTED_SCHEME",
    });
    expect(validateVerificationTarget("https://u:p@127.0.0.1:8080/x")).toEqual({
      ok: false,
      code: "EMBEDDED_CREDENTIALS",
    });
    expect(validateVerificationTarget("https://127.0.0.1:8080/x")).toEqual({
      ok: false,
      code: "PRIVATE_NETWORK_BLOCKED",
    });
    expect(validateVerificationTarget("https://intranet:8080/x")).toEqual({
      ok: false,
      code: "INVALID_TARGET",
    });
    expect(
      validateVerificationTarget("https://shop.example.com:8080/x"),
    ).toEqual({ ok: false, code: "PORT_NOT_ALLOWED" });
  });

  it("answers only with the listed codes", () => {
    for (const input of ["ftp://x.com", "127.0.0.1", "x", "x.com/a"]) {
      const result = validateVerificationTarget(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(VERIFICATION_TARGET_FAILURES).toContain(result.code);
      }
    }
  });

  it("still accepts characters IDNA maps rather than drops", () => {
    // A full-width letter and the ideographic full stop become ASCII: they
    // are visible, and nothing disappears.
    expect(validateVerificationTarget("\uff53hop\u3002example.com")).toEqual({
      ok: true,
      hostname: "shop.example.com",
    });
  });

  it("stores what normalizeHostname would", () => {
    for (const input of ["Shop.Example.com.", "bücher.de", "shop.xn--p1ai"]) {
      const result = validateVerificationTarget(input);
      expect(result).toEqual({
        ok: true,
        hostname: normalizeHostname(input),
      });
    }
  });
});

describe("isPublicAddress", () => {
  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.215.14",
    "100.63.255.255",
    "100.128.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "192.167.255.255",
    "192.169.0.0",
    "223.255.255.255",
    "2606:4700:4700::1111",
    "2a00:1450:4001:80b::200e",
    "::ffff:8.8.8.8",
    "::ffff:808:808",
  ])("allows %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    ["this network", "0.0.0.0"],
    ["this network", "0.255.255.255"],
    ["private", "10.0.0.1"],
    ["shared address space", "100.64.0.1"],
    ["Alibaba's metadata", "100.100.100.200"],
    ["loopback", "127.0.0.1"],
    ["loopback", "127.255.255.254"],
    ["link-local", "169.254.0.1"],
    ["cloud metadata", "169.254.169.254"],
    ["private", "172.16.0.1"],
    ["private", "172.31.255.255"],
    ["IETF protocol space, Oracle's metadata", "192.0.0.192"],
    ["documentation", "192.0.2.1"],
    ["6to4 relay", "192.88.99.1"],
    ["private", "192.168.1.1"],
    ["benchmarking", "198.18.0.1"],
    ["benchmarking", "198.19.255.255"],
    ["documentation", "198.51.100.1"],
    ["documentation", "203.0.113.1"],
    ["multicast", "224.0.0.1"],
    ["reserved", "240.0.0.1"],
    ["broadcast", "255.255.255.255"],
    ["unspecified", "::"],
    ["loopback", "::1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["IPv4-mapped loopback, hex", "::ffff:7f00:1"],
    ["IPv4-mapped metadata", "0:0:0:0:0:ffff:169.254.169.254"],
    ["IPv4-compatible", "::127.0.0.1"],
    ["NAT64", "64:ff9b::7f00:1"],
    ["discard", "100::1"],
    ["Teredo", "2001::1"],
    ["IETF protocol space", "2001:1::1"],
    ["documentation", "2001:db8::1"],
    ["6to4", "2002:7f00:1::1"],
    ["documentation", "3fff::1"],
    ["unique-local", "fc00::1"],
    ["unique-local", "fd12:3456:789a::1"],
    ["AWS's IPv6 metadata", "fd00:ec2::254"],
    ["link-local", "fe80::1"],
    ["link-local with a zone", "fe80::1%eth0"],
    ["site-local", "fec0::1"],
    ["multicast", "ff02::1"],
    ["outside global unicast", "4000::1"],
    ["outside global unicast", "e000::1"],
  ])("refuses %s (%s)", (_label, address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    ["a name", "example.com"],
    ["a hexadecimal IPv4 form", "0x7f.1"],
    ["a decimal IPv4 form", "2130706433"],
    ["a bracketed IPv6 address", "[2606:4700:4700::1111]"],
    ["an empty string", ""],
  ])("refuses anything it can't read as an address: %s", (_label, input) => {
    expect(isPublicAddress(input)).toBe(false);
  });
});
