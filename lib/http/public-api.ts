import "server-only";

import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { logger } from "@/lib/logging/logger";
import { RateLimitUnavailableError } from "@/lib/security/rate-limit";

/**
 * The shape of the public endpoint's responses (TASK-019a).
 *
 * Deliberately not `lib/http/api.ts`: that module's `jsonResponse` sends
 * `private, no-store` on every dashboard response and must keep doing so.
 * Rather than give it a `cache` option — which would put a public cache one
 * wrong argument away from every route that serves a member's data — the one
 * cacheable, cross-origin response builder in this application is its own
 * module, and `grep` finds every public response in one place.
 */

/**
 * About a minute, publicly cacheable, with up to five minutes of background
 * revalidation (owner, 2026-09-26). `max-age=0` keeps it out of the
 * visitor's own cache, so a corrected or withdrawn notice reaches a
 * returning visitor on their next page load while the shared cache still
 * absorbs the load.
 */
export const PUBLIC_CACHE_CONTROL =
  "public, max-age=0, s-maxage=60, stale-while-revalidate=300";

const NO_STORE = "private, no-store";

/**
 * Only answers that are a pure function of the URL may be cached. A `429`
 * would hand one caller's refusal to everyone behind the same shared cache,
 * and a `503` would outlive the outage that caused it.
 */
function cacheControlFor(status: number): string {
  return status === 200 || status === 400 || status === 404
    ? PUBLIC_CACHE_CONTROL
    : NO_STORE;
}

/**
 * Readable from any origin, with no credentials and no `Vary` (owner's
 * decision recorded in TASK-019a): reflecting a registered hostname would
 * vary the cache by origin and turn the endpoint into an oracle for which
 * hostnames are registered, while stopping nobody — anyone can call this
 * without a browser. The plan calls this a deliberate exception; it is not
 * authorization.
 *
 * `nosniff` is set here as well as in `next.config.ts` — which applies it to
 * every path — so this endpoint's guarantee does not depend on a
 * configuration file that could be narrowed for another reason. The proxy,
 * which sets the rest of the dashboard's headers, deliberately does not run
 * here.
 */
function publicHeaders(
  status: number,
  retryAfterSeconds?: number,
): Record<string, string> {
  return {
    "Cache-Control": cacheControlFor(status),
    "Access-Control-Allow-Origin": "*",
    "X-Content-Type-Options": "nosniff",
    ...(retryAfterSeconds === undefined
      ? {}
      : { "Retry-After": String(retryAfterSeconds) }),
  };
}

/** A successful public response: the body, and nothing about the caller. */
export function publicJsonResponse(body: unknown): NextResponse {
  return NextResponse.json(body, { status: 200, headers: publicHeaders(200) });
}

/**
 * A refusal the route decided on. Expected answers — a malformed identifier
 * or nothing to show — carry the code alone: they are outcomes rather than
 * faults, and a reference per unknown identifier would let the public
 * decide this application's log volume (owner, 2026-09-26).
 */
export class PublicRequestError extends Error {
  override readonly name = "PublicRequestError";

  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Public request refused (${code})`);
  }
}

/** The same format as the proxy's and the dashboard API's. */
function newReference(): string {
  return `err_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

/**
 * A fault, not an outcome: it carries a reference that finds the log entry,
 * and never a message, stack trace, SQL, or anything from the request.
 */
function faultResponse(
  route: string,
  status: number,
  code: string,
  context: Record<string, unknown>,
): NextResponse {
  const reference = newReference();
  logger.error(
    {
      event: "public_request_failed",
      route,
      status,
      code,
      reference,
      ...context,
    },
    "A public request failed",
  );
  return NextResponse.json(
    { error: { code, reference } },
    { status, headers: publicHeaders(status) },
  );
}

/**
 * An error meaning the database could not answer: a `503` the caller may
 * retry, rather than a `500`. Marked with a property rather than listed by
 * class here, so `lib/http` does not have to import from `features`.
 */
export type PublicUnavailable = { readonly unavailable: true };

function isUnavailable(error: unknown): boolean {
  return (
    error instanceof RateLimitUnavailableError ||
    (typeof error === "object" &&
      error !== null &&
      "unavailable" in error &&
      error.unavailable === true)
  );
}

/**
 * Runs a public route handler and turns whatever it throws into the public
 * error format. The mapping is in one place, so a handler cannot answer one
 * failure two ways, and nothing it throws reaches a caller raw.
 */
export async function handlePublicRequest(
  route: string,
  handler: () => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof PublicRequestError) {
      // No log line: a malformed identifier and a deployment with nothing
      // to show are answers, not failures.
      return NextResponse.json(
        { error: { code: error.code } },
        {
          status: error.status,
          headers: publicHeaders(error.status, error.retryAfterSeconds),
        },
      );
    }
    const errorName = error instanceof Error ? error.name : "unknown";
    if (isUnavailable(error)) {
      return faultResponse(route, 503, "service_unavailable", {
        errorName,
        databaseCode: databaseCodeOf(error),
      });
    }
    // The name and a database's SQLSTATE only: a message can carry SQL, a
    // hostname, or input.
    return faultResponse(route, 500, "internal_error", {
      errorName,
      databaseCode: databaseCodeOf(error),
    });
  }
}

function databaseCodeOf(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "databaseCode" in error &&
    typeof error.databaseCode === "string" &&
    /^[0-9A-Z]{5}$/.test(error.databaseCode)
    ? error.databaseCode
    : undefined;
}
