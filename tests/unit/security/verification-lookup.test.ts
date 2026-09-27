import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  type AddressResolver,
  createGuardedLookup,
  createLookupRecord,
  LOOKUP_REFUSALS,
  type ResolvedAddress,
} from "@/lib/security/verification-lookup";

/**
 * The guarded lookup (TASK-023) against a fake resolver. The fake is the
 * point: the filtering has to be proven against addresses no test machine can
 * own — a resolver that answers `169.254.169.254` proves the refusal without
 * a network, and without hoping a public name still resolves the way it did
 * when the test was written.
 */

/** A resolver that answers with exactly these addresses, and counts calls. */
function fakeResolver(...addresses: readonly string[]) {
  const calls: { hostname: string; family: number }[] = [];
  const resolve: AddressResolver = (hostname, family, callback) => {
    calls.push({ hostname, family });
    setImmediate(() => {
      callback(
        null,
        addresses.map((address) => ({
          address,
          family: address.includes(":") ? 6 : 4,
        })),
      );
    });
  };
  return { resolve, calls };
}

function lookupOnce(
  resolve: AddressResolver,
  options: { all?: boolean; family?: number } = {},
) {
  const record = createLookupRecord();
  const lookup = createGuardedLookup(record, resolve);
  return new Promise<{
    error: Error | null;
    address: string | readonly ResolvedAddress[];
    family: number | undefined;
    record: ReturnType<typeof createLookupRecord>;
  }>((settle) => {
    lookup("shop.example.com", options, (error, address, family) => {
      settle({ error: error ?? null, address, family, record });
    });
  });
}

describe("the guarded lookup", () => {
  it("hands the socket a public address, with its family", async () => {
    const { resolve } = fakeResolver("93.184.216.34");

    const result = await lookupOnce(resolve);

    expect(result.error).toBeNull();
    expect(result.address).toBe("93.184.216.34");
    expect(result.family).toBe(4);
    expect(result.record.address).toBe("93.184.216.34");
    expect(result.record.refusal).toBeNull();
  });

  it("answers with an array when the socket asked for all of them", async () => {
    const { resolve } = fakeResolver("93.184.216.34", "2606:4700::1111");

    const result = await lookupOnce(resolve, { all: true });

    // One address even so: Happy Eyeballs would race a list, and then no row
    // could say which address answered.
    expect(result.address).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it.each([
    ["loopback", "127.0.0.1"],
    ["a private address", "10.1.2.3"],
    ["link-local", "169.254.1.1"],
    ["the cloud metadata address", "169.254.169.254"],
    ["Alibaba's metadata address", "100.100.100.200"],
    ["Oracle's metadata address", "192.0.0.192"],
    ["carrier-grade NAT", "100.64.0.1"],
    ["an IPv6 loopback", "::1"],
    ["a unique-local address", "fd00:ec2::254"],
    ["an IPv6 link-local address", "fe80::1"],
  ])("refuses a name that resolves only to %s", async (_label, address) => {
    const { resolve } = fakeResolver(address);

    const result = await lookupOnce(resolve);

    expect(result.error).not.toBeNull();
    expect(result.record.refusal).toBe("PRIVATE_NETWORK_BLOCKED");
    expect(result.record.address).toBeNull();
  });

  it("refuses a rebinding answer even when one address is public", async () => {
    // The shape that matters: a resolver offering a public address and a
    // private one. What the socket gets is filtered, so the private address
    // is never connected to whichever one the resolver "preferred".
    const { resolve } = fakeResolver("169.254.169.254", "93.184.216.34");

    const result = await lookupOnce(resolve);

    expect(result.error).toBeNull();
    expect(result.address).toBe("93.184.216.34");
    expect(result.record.refusal).toBeNull();
  });

  it("tells a name that does not resolve from one that resolves privately", async () => {
    const { resolve } = fakeResolver();

    const empty = await lookupOnce(resolve);
    expect(empty.record.refusal).toBe("DNS_ERROR");

    const failing: AddressResolver = (_hostname, _family, callback) => {
      callback(new Error("getaddrinfo ENOTFOUND"), []);
    };
    const failed = await lookupOnce(failing);
    expect(failed.record.refusal).toBe("DNS_ERROR");
    expect(failed.error?.message).toContain("ENOTFOUND");
  });

  it("names the host in its error and nothing else", async () => {
    const { resolve } = fakeResolver("169.254.169.254");

    const result = await lookupOnce(resolve);

    // An error can reach a log; the address the resolver returned must not.
    expect(result.error?.message).toBe(
      "no public address for shop.example.com",
    );
    expect(result.error?.message).not.toContain("169.254");
  });

  it("resolves once per attempt, and passes the family it was asked for", async () => {
    const { resolve, calls } = fakeResolver("93.184.216.34");
    const record = createLookupRecord();
    const lookup = createGuardedLookup(record, resolve);

    await new Promise<void>((settle) => {
      lookup("shop.example.com", { family: 4 }, () => settle());
    });

    expect(calls).toEqual([{ hostname: "shop.example.com", family: 4 }]);
    expect(record.resolutions).toBe(1);
  });

  it("reads the family spelling net may use", async () => {
    const { resolve, calls } = fakeResolver("2606:4700::1111");
    const record = createLookupRecord();
    const lookup = createGuardedLookup(record, resolve);

    await new Promise<void>((settle) => {
      // `net` may pass "IPv6" rather than 6.
      lookup(
        "shop.example.com",
        { family: "IPv6" } as unknown as { family: number },
        () => settle(),
      );
    });

    expect(calls[0]?.family).toBe(6);
  });

  it("has a refusal for each README §19 code it can produce", () => {
    expect([...LOOKUP_REFUSALS]).toEqual([
      "DNS_ERROR",
      "PRIVATE_NETWORK_BLOCKED",
    ]);
  });
});
