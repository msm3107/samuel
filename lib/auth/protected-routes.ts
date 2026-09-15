export const SIGN_IN_PATH = "/sign-in";

/**
 * The proxy protects the `/dashboard` URL prefix and the dashboard layout
 * protects the `app/(dashboard)` route group. Route groups add no URL segment,
 * so the two coincide only if every page in the group lives under
 * `app/(dashboard)/dashboard/`. A test enforces that.
 */
export const DASHBOARD_ROUTE_DIRECTORY = "app/(dashboard)/dashboard";

/**
 * Whether the proxy should require a session before the request reaches the
 * dashboard. Normalized first, so percent-encoded, repeated-slash, and
 * differently-cased spellings of a dashboard path are not waved through. A
 * path that cannot be decoded is treated as protected: failing closed costs a
 * redirect, failing open costs the check.
 */
export function isDashboardPath(pathname: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true;
  }

  const normalized = decoded.replace(/\/{2,}/g, "/").toLowerCase();

  return DASHBOARD_PATH_PATTERN.test(normalized);
}

/**
 * `/dashboard`, anything below it, and the App Router transport forms of it
 * (`/dashboard.rsc`, `/dashboard.segments/…`). The proxy receives some of those
 * with only a trailing `.rsc` stripped, so a `/`-only prefix test would let a
 * segment prefetch through.
 */
const DASHBOARD_PATH_PATTERN = /^\/dashboard(?:$|[/.])/;
