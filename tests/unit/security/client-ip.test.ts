import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  clientNetwork,
  LOCAL_NETWORK,
  networkOf,
  UNKNOWN_NETWORK,
} from "@/lib/security/client-ip";

function headers(entries: Record<string, string>) {
  return new Headers(entries);
}

describe("clientNetwork", () => {
  it("trusts Vercel's platform header on Vercel", () => {
    expect(
      clientNetwork(headers({ "x-vercel-forwarded-for": "203.0.113.7" }), {
        onVercel: true,
      }),
    ).toBe("203.0.113.7");
  });

  it.each([
    ["x-vercel-forwarded-for", "203.0.113.7"],
    ["x-forwarded-for", "203.0.113.7"],
    ["x-real-ip", "203.0.113.7"],
  ])("ignores %s off Vercel, where a client could write it", (name, value) => {
    expect(clientNetwork(headers({ [name]: value }), { onVercel: false })).toBe(
      LOCAL_NETWORK,
    );
  });

  it("does not fall back to x-forwarded-for, which a proxy in front of Vercel can rewrite", () => {
    expect(
      clientNetwork(headers({ "x-forwarded-for": "203.0.113.7" }), {
        onVercel: true,
      }),
    ).toBe(UNKNOWN_NETWORK);
  });

  it.each(["", "not-an-ip", "203.0.113.999", "<script>"])(
    "puts an unreadable platform header (%j) in the shared unknown bucket",
    (value) => {
      expect(
        clientNetwork(headers({ "x-vercel-forwarded-for": value }), {
          onVercel: true,
        }),
      ).toBe(UNKNOWN_NETWORK);
    },
  );

  it("reads the first address of a list", () => {
    expect(
      clientNetwork(
        headers({ "x-vercel-forwarded-for": "203.0.113.7, 198.51.100.1" }),
        { onVercel: true },
      ),
    ).toBe("203.0.113.7");
  });
});

describe("networkOf", () => {
  it("keeps an IPv4 address whole", () => {
    expect(networkOf("198.51.100.23")).toBe("198.51.100.23");
  });

  it("puts every address in one IPv6 /64 in the same network", () => {
    const networks = [
      "2001:db8:1:2::1",
      "2001:db8:1:2:ffff:ffff:ffff:ffff",
      "2001:0db8:0001:0002:abcd:0:0:1",
      "2001:DB8:1:2::dead:beef",
    ].map(networkOf);

    expect(new Set(networks)).toEqual(new Set(["2001:db8:1:2::/64"]));
  });

  it("separates neighbouring /64s", () => {
    expect(networkOf("2001:db8:1:2::1")).not.toBe(networkOf("2001:db8:1:3::1"));
  });

  it.each([
    ["::1", "0:0:0:0::/64"],
    ["::", "0:0:0:0::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
    ["2001:db8::", "2001:db8:0:0::/64"],
    ["1:2:3:4:5:6:7:8", "1:2:3:4::/64"],
    ["64:ff9b::192.0.2.33", "64:ff9b:0:0::/64"],
  ])("normalizes %s to %s", (address, network) => {
    expect(networkOf(address)).toBe(network);
  });

  it("treats an IPv4-mapped IPv6 address as its IPv4 client", () => {
    expect(networkOf("::ffff:198.51.100.23")).toBe("198.51.100.23");
    expect(networkOf("::ffff:c633:6417")).toBe("198.51.100.23");
  });

  it.each(["", "localhost", "1.2.3", "2001:db8::g", "::ffff:999.1.1.1"])(
    "returns null for %j",
    (value) => {
      expect(networkOf(value)).toBeNull();
    },
  );
});
