import { NextResponse, type NextRequest } from "next/server";

import { completeSignIn } from "@/lib/auth/sign-in/complete-sign-in";
import { signedInUrl, signInErrorUrl } from "@/lib/auth/sign-in/urls";

/**
 * Where magic links and Google send the browser back. Session cookies written
 * during the exchange travel on this response, so it must never be cached:
 * one person's session would be served to the next.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  const result = await completeSignIn({
    code: exactlyOne(params, "code"),
    flowId: exactlyOne(params, "sb_flow_id"),
    providerError: params.get("error"),
    providerErrorCode: params.get("error_code"),
  });

  const destination =
    result.status === "signed-in" ? signedInUrl() : signInErrorUrl(result.code);

  const response = NextResponse.redirect(destination, 303);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

/**
 * A repeated parameter is ambiguous: an edge proxy, a log pipeline, and the
 * application can each pick a different value. Returning the array makes it
 * fail validation, so an ambiguous callback is refused rather than resolved —
 * and a single-use code the caller did not choose is never spent.
 */
function exactlyOne(params: URLSearchParams, name: string): unknown {
  const values = params.getAll(name);
  if (values.length === 1) {
    return values[0];
  }
  return values.length === 0 ? null : values;
}
