/**
 * Two years, subdomains included, preload-eligible.
 *
 * One definition, applied in two places on purpose (PR #36 review, note 1):
 * `next.config.ts` sets it on every path the framework serves, including
 * `/api/public/…`, which the proxy deliberately does not match; `proxy.ts`
 * sets it again on the responses it returns itself — the sign-in redirect
 * and the session-unavailable 503 — which never reach the framework's own
 * header pipeline.
 *
 * Neither place holds the value, so they cannot drift apart.
 */
export const STRICT_TRANSPORT_SECURITY =
  "max-age=63072000; includeSubDomains; preload";
