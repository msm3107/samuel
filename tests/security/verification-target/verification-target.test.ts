import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { validateVerificationTarget } from "@/lib/security/verification-target";

/**
 * Phase 4's exit criteria (.ai/PLAN.md): each of these targets is refused
 * with its own deterministic failure code, so a deployment can never point
 * the verifier at the application's own network.
 */
describe("verification targets the verifier must never reach", () => {
  it.each([
    ["localhost", "localhost", "PRIVATE_NETWORK_BLOCKED"],
    ["a loopback address", "127.0.0.1", "PRIVATE_NETWORK_BLOCKED"],
    ["loopback in a URL", "http://127.0.0.1/", "PRIVATE_NETWORK_BLOCKED"],
    [
      "the cloud metadata address",
      "169.254.169.254",
      "PRIVATE_NETWORK_BLOCKED",
    ],
    [
      "the metadata address in a URL",
      "http://169.254.169.254/latest/meta-data/",
      "PRIVATE_NETWORK_BLOCKED",
    ],
    [
      "a metadata host name",
      "metadata.google.internal",
      "PRIVATE_NETWORK_BLOCKED",
    ],
    ["IPv6 loopback", "[::1]", "PRIVATE_NETWORK_BLOCKED"],
    ["IPv6 loopback in a URL", "http://[::1]/", "PRIVATE_NETWORK_BLOCKED"],
    ["a private IPv6 address", "[fd00::1]", "PRIVATE_NETWORK_BLOCKED"],
    ["a link-local IPv6 address", "[fe80::1]", "PRIVATE_NETWORK_BLOCKED"],
    ["a private IPv4 address", "10.0.0.1", "PRIVATE_NETWORK_BLOCKED"],
    ["a private IPv4 address", "192.168.1.1", "PRIVATE_NETWORK_BLOCKED"],
    [
      "an embedded-credential URL",
      "https://user:password@shop.example.com/",
      "EMBEDDED_CREDENTIALS",
    ],
    ["a non-HTTP scheme", "ftp://shop.example.com/", "UNSUPPORTED_SCHEME"],
    ["a file URL", "file:///etc/passwd", "UNSUPPORTED_SCHEME"],
    [
      "an unexpected port",
      "https://shop.example.com:8443/",
      "PORT_NOT_ALLOWED",
    ],
  ])("refuses %s (%j) with %s", (_label, input, code) => {
    expect(validateVerificationTarget(input)).toEqual({ ok: false, code });
  });

  it.each([
    "http://0x7f.1/",
    "http://2130706433/",
    "http://127.0.0.0x1/",
    "http://169.254.169.0xfe/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:169.254.169.254]/",
  ])("refuses the disguised internal address %j", (input) => {
    expect(validateVerificationTarget(input)).toEqual({
      ok: false,
      code: "PRIVATE_NETWORK_BLOCKED",
    });
  });
});
