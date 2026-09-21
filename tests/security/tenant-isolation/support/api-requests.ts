import { serverEnv } from "@/lib/env/server-env";

/**
 * Requests for the organization route handlers (TASK-007), built the way a
 * browser on the application's own pages would send them: the configured
 * Origin and a JSON content type. Each option exists so a test can change
 * exactly one of those and nothing else.
 */
export function apiRequest(
  method: "GET" | "POST" | "PATCH",
  path: string,
  options: {
    body?: unknown;
    rawBody?: string;
    origin?: string | null;
    contentType?: string | null;
  } = {},
): Request {
  const appUrl = serverEnv().NEXT_PUBLIC_APP_URL;
  const headers = new Headers();

  const origin =
    options.origin === undefined ? new URL(appUrl).origin : options.origin;
  if (origin !== null) {
    headers.set("origin", origin);
  }

  const hasBody = options.body !== undefined || options.rawBody !== undefined;
  const contentType =
    options.contentType === undefined
      ? hasBody
        ? "application/json"
        : null
      : options.contentType;
  if (contentType !== null) {
    headers.set("content-type", contentType);
  }

  return new Request(new URL(path, appUrl), {
    method,
    headers,
    body: hasBody ? (options.rawBody ?? JSON.stringify(options.body)) : null,
  });
}

/** The route context Next.js passes a dynamic route handler. */
export function routeContext(organizationId: string) {
  return { params: Promise.resolve({ organizationId }) };
}

/** Every error body is exactly `{ error: { code, reference } }`. */
export async function readError(
  response: Response,
): Promise<{ code: string; reference: string }> {
  const body = (await response.json()) as { error: unknown };
  expectErrorShape(body);
  return body.error as { code: string; reference: string };
}

function expectErrorShape(body: { error: unknown }) {
  const keys = Object.keys(body);
  const error = body.error as Record<string, unknown> | undefined;
  if (
    keys.length !== 1 ||
    typeof error !== "object" ||
    error === null ||
    Object.keys(error).sort().join(",") !== "code,reference" ||
    typeof error.code !== "string" ||
    typeof error.reference !== "string" ||
    !/^err_[0-9a-f]{12}$/.test(error.reference)
  ) {
    throw new Error(
      `Unexpected error body shape: ${JSON.stringify(Object.keys(body))}`,
    );
  }
}
