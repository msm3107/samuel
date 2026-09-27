import "server-only";

import { lookup as dnsLookup } from "node:dns";
import type { LookupFunction } from "node:net";

import { isPublicAddress } from "@/lib/security/verification-target";

/**
 * The guarded DNS lookup (TASK-023; README §17, "do not trust DNS resolution
 * only once"). It resolves a name, drops every address
 * `isPublicAddress` refuses, and hands the socket exactly one.
 *
 * This is where DNS rebinding is stopped, and the reason it works is the
 * shape rather than the checks: Node's socket connects to the address its
 * `lookup` returned, so there is no window between validating an address and
 * connecting to it. Resolving separately and then connecting to the name
 * again would re-resolve, and a resolver that answered `93.184.216.34` the
 * first time may answer `169.254.169.254` the second.
 *
 * Nothing here decides whether a *name* may be fetched. That is
 * `validateVerificationTarget`, which ran before the deployment was stored.
 */

/** Why an attempt was refused here. Both are README §19 codes. */
export const LOOKUP_REFUSALS = [
  "DNS_ERROR",
  "PRIVATE_NETWORK_BLOCKED",
] as const;

export type LookupRefusal = (typeof LOOKUP_REFUSALS)[number];

export type ResolvedAddress = Readonly<{ address: string; family: number }>;

/**
 * What the guarded lookup resolves with. The seam exists so the filtering
 * can be tested against addresses no test machine can own — a fake resolver
 * that answers `169.254.169.254` proves the refusal without a network.
 */
export type AddressResolver = (
  hostname: string,
  family: number,
  callback: (
    error: Error | null,
    addresses: readonly ResolvedAddress[],
  ) => void,
) => void;

/**
 * What one request learned. The refusal is recorded here rather than read
 * off the socket error, because `net` rewrites the error it is given and the
 * difference between `DNS_ERROR` and `PRIVATE_NETWORK_BLOCKED` is evidence —
 * it must not depend on a custom property surviving that.
 */
export type LookupRecord = {
  /** One per connection attempt: the name is resolved once per attempt. */
  resolutions: number;
  /** The address handed to the socket, if one passed. */
  address: string | null;
  /** Why the last attempt was refused, if it was. */
  refusal: LookupRefusal | null;
};

export function createLookupRecord(): LookupRecord {
  return { resolutions: 0, address: null, refusal: null };
}

/** `dns.lookup`, asked for every address so the filtering sees all of them. */
export const resolveAddresses: AddressResolver = (
  hostname,
  family,
  callback,
) => {
  dnsLookup(
    hostname,
    // `verbatim` keeps the resolver's order rather than sorting IPv4 first;
    // the order decides which address is used, and the resolver's own
    // preference is the one the site's operator configured.
    { all: true, family, verbatim: true },
    (error, addresses) => {
      if (error) {
        callback(error, []);
        return;
      }
      callback(null, addresses);
    },
  );
};

/**
 * A `lookup` for `http.request`, bound to one record. Every address it
 * returns has passed `isPublicAddress`; when none has, the socket gets an
 * error and the record says why.
 *
 * Only one address is returned, even when the resolver offered several.
 * `autoSelectFamily` would otherwise race them, and a row could not say
 * which address answered.
 */
export function createGuardedLookup(
  record: LookupRecord,
  resolve: AddressResolver = resolveAddresses,
): LookupFunction {
  return (hostname, options, callback) => {
    record.resolutions += 1;
    resolve(hostname, addressFamily(options.family), (error, addresses) => {
      if (error) {
        record.refusal = "DNS_ERROR";
        callback(error, "", 0);
        return;
      }
      const allowed = addresses.filter((candidate) =>
        isPublicAddress(candidate.address),
      );
      const picked = allowed[0];
      if (picked === undefined) {
        // A name that resolved to nothing is a resolver failure; a name that
        // resolved only to addresses the verifier may not reach is a
        // blocked target. They are different facts about the customer's
        // setup, so they are different codes.
        record.refusal =
          addresses.length === 0 ? "DNS_ERROR" : "PRIVATE_NETWORK_BLOCKED";
        callback(refusalError(hostname, record.refusal), "", 0);
        return;
      }
      record.address = picked.address;
      record.refusal = null;
      // `net` asks for every address when Happy Eyeballs is on and for one
      // when it is not. Both shapes are answered, so a caller that forgets
      // to turn it off still gets a single validated address rather than a
      // raced list.
      if (options.all === true) {
        callback(null, [{ address: picked.address, family: picked.family }]);
        return;
      }
      callback(null, picked.address, picked.family);
    });
  };
}

/**
 * The family `net` asked for, as `dns.lookup` takes it. `net` may pass a
 * number or the spelling `"IPv4"`; 0 means either.
 */
function addressFamily(family: number | string | undefined): number {
  if (family === 4 || family === "IPv4") {
    return 4;
  }
  if (family === 6 || family === "IPv6") {
    return 6;
  }
  return 0;
}

/**
 * The error the socket is destroyed with. It names the host and nothing
 * else: an error that reaches a log must not carry an internal address the
 * resolver happened to return.
 */
function refusalError(hostname: string, refusal: LookupRefusal): Error {
  const error: Error & { code?: string } = new Error(
    refusal === "DNS_ERROR"
      ? `no address for ${hostname}`
      : `no public address for ${hostname}`,
  );
  error.code = `ERR_VERIFICATION_${refusal}`;
  return error;
}
