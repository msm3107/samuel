import "server-only";

import { isIPv4, isIPv6 } from "node:net";

import { serverEnv } from "@/lib/env/server-env";

/**
 * Every request off Vercel (local development, the end-to-end suites) shares
 * this one network, so a forged header can never earn a fresh bucket.
 */
export const LOCAL_NETWORK = "local";

/** On Vercel, a request whose platform header is missing or unreadable. */
export const UNKNOWN_NETWORK = "unknown";

/**
 * Vercel sets it on every request and, unlike `x-forwarded-for`, a proxy in
 * front of Vercel cannot overwrite it (vercel.com/docs/headers/request-headers).
 */
const VERCEL_CLIENT_IP_HEADER = "x-vercel-forwarded-for";

/**
 * The client network a request's rate limits are counted against: an IPv4
 * address, or an IPv6 /64 prefix, because one host can own a whole /64 and
 * keying on full IPv6 addresses would give it 2^64 fresh buckets.
 *
 * Platform headers are trusted only when `onVercel` is true. Anywhere else a
 * client could write them, so every request shares `LOCAL_NETWORK`.
 */
export function clientNetwork(
  headers: Pick<Headers, "get">,
  { onVercel }: { onVercel: boolean },
): string {
  if (!onVercel) {
    return LOCAL_NETWORK;
  }
  const first = headers.get(VERCEL_CLIENT_IP_HEADER)?.split(",")[0]?.trim();
  return networkOf(first ?? "") ?? UNKNOWN_NETWORK;
}

/** `clientNetwork`, trusting platform headers only when running on Vercel. */
export function requestNetwork(headers: Pick<Headers, "get">): string {
  return clientNetwork(headers, { onVercel: serverEnv().VERCEL === "1" });
}

/** The network an address belongs to, or null if it is not an IP address. */
export function networkOf(address: string): string | null {
  if (isIPv4(address)) {
    return address;
  }
  if (!isIPv6(address)) {
    return null;
  }
  const groups = expandIPv6(address);
  // An IPv4-mapped address (::ffff:a.b.c.d) is that IPv4 client.
  if (
    groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff
  ) {
    const high = groups[6] ?? 0;
    const low = groups[7] ?? 0;
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }
  const prefix = groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":");
  return `${prefix}::/64`;
}

/** Eight 16-bit groups from a valid IPv6 address (already checked by isIPv6). */
function expandIPv6(address: string): number[] {
  // A zone index (fe80::1%eth0) names a local interface, not a network.
  let text = address.split("%")[0] ?? "";

  // A trailing dotted IPv4 part becomes two hex groups.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
    ];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const [head = "", tail] = text.split("::");
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === undefined || tail === "" ? [] : tail.split(":");
  const missing =
    tail === undefined ? 0 : 8 - headGroups.length - tailGroups.length;

  return [
    ...headGroups,
    ...Array<string>(missing).fill("0"),
    ...tailGroups,
  ].map((group) => Number.parseInt(group, 16));
}
