import "server-only";

import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";
import type { z } from "zod";

import {
  AuthenticationError,
  AuthorizationError,
  MembershipLookupError,
  SessionLookupError,
} from "@/lib/auth/errors";
import { serverEnv } from "@/lib/env/server-env";
import { logger } from "@/lib/logging/logger";

/**
 * The shared shape of every JSON API route (TASK-007).
 *
 * Every error a client sees is `{ "error": { "code", "reference" } }`: a
 * stable code it can act on, and a reference that finds the server's log
 * entry. Never a message, stack trace, SQL, or anything from the request.
 */

/** A refusal the route decided on, with the status and code to send. */
export class ApiRequestError extends Error {
  override readonly name = "ApiRequestError";

  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`API request refused (${code})`);
  }
}

/** Past this, a body is refused before it is parsed. */
export const MAX_JSON_BODY_BYTES = 4096;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/** Every response carries per-user data or a per-request error: never cached. */
export function jsonResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** The same format as the proxy's, so one search finds either. */
function newReference(): string {
  return `err_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function errorResponse(
  route: string,
  status: number,
  code: string,
  context: Record<string, unknown> = {},
): NextResponse {
  const reference = newReference();
  const entry = { event: "api_request_failed", route, status, code, reference };
  if (status >= 500) {
    logger.error({ ...entry, ...context }, "An API request failed");
  } else {
    logger.info(entry, "An API request was refused");
  }
  return jsonResponse({ error: { code, reference } }, status);
}

/**
 * Runs a route handler and turns whatever it throws into the error format.
 * The mapping is in one place, so a handler cannot send a different status
 * for the same failure, and nothing it throws reaches the client raw.
 *
 * Every authorization refusal is 403 with one code, whether the organization
 * does not exist, was deleted, or belongs to someone else, so the status
 * cannot be used to probe which organizations exist.
 */
export async function handleApiRequest(
  route: string,
  handler: () => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return errorResponse(route, error.status, error.code);
    }
    if (error instanceof AuthenticationError) {
      return errorResponse(route, 401, "authentication_required");
    }
    if (error instanceof AuthorizationError) {
      return errorResponse(route, 403, error.code);
    }
    if (
      error instanceof SessionLookupError ||
      error instanceof MembershipLookupError
    ) {
      return errorResponse(route, 503, "service_unavailable", {
        errorName: error.name,
      });
    }
    // The name and a database's SQLSTATE only: a message can carry SQL, a
    // hostname, or input.
    return errorResponse(route, 500, "internal_error", {
      errorName: error instanceof Error ? error.name : "unknown",
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

/**
 * Cross-site request forgery. A state-changing request must come from this
 * application's own pages: its `Origin` must be the configured origin.
 * Browsers always send `Origin` on a POST or PATCH, so a missing one is
 * refused too; a non-browser client has no cookies to be tricked into
 * sending. Checked against configuration, never against the `Host` header,
 * which the request controls.
 *
 * The session cookie is `SameSite=Lax` as well, but that still lets a sibling
 * subdomain send it, so it is not relied on alone.
 */
export function assertSameOrigin(request: Request): void {
  const expected = new URL(serverEnv().NEXT_PUBLIC_APP_URL).origin;
  if (request.headers.get("origin") !== expected) {
    throw new ApiRequestError(403, "cross_origin_request_refused");
  }
}

/**
 * Reads a JSON body and validates it with `schema`, or refuses the request.
 *
 * Only `application/json`: an HTML form cannot send it cross-site without a
 * preflight. The size is capped while reading, not from `Content-Length`
 * alone, which the client controls. Validation failures say which rule
 * failed only through the code, never by echoing the input back.
 */
export async function readJsonBody<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
): Promise<z.infer<Schema>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new ApiRequestError(415, "unsupported_media_type");
  }

  const text = await readBoundedText(request, MAX_JSON_BODY_BYTES);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiRequestError(400, "invalid_json");
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ApiRequestError(400, "invalid_request");
  }
  return result.data;
}

async function readBoundedText(
  request: Request,
  maxBytes: number,
): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiRequestError(413, "request_too_large");
  }
  if (request.body === null) {
    return "";
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ApiRequestError(413, "request_too_large");
    }
    chunks.push(value);
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new ApiRequestError(400, "invalid_json");
  }
}
