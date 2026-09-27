import "server-only";

import { fetchPage } from "@/features/verification/fetch-page.internal";

/**
 * The verifier's fetch, as the application may call it (TASK-023; README §17,
 * §18): a hostname, and nothing else.
 *
 * The implementation lives in `fetch-page.internal.ts`, which takes three test
 * seams. Two of them are contained — `resolve` still feeds the guarded lookup,
 * and `ports` still needs a public address — but `lookup` replaces the guard
 * outright, and a module whose stated reason for constant bounds is that no
 * caller may widen them cannot also hand a caller the guard (PR #40 review,
 * note 3).
 *
 * So the seams are not on this surface at all, and an ESLint rule allows the
 * internal module to be imported only from here and from `tests/`. A rule that
 * fires at review time was chosen over a `NODE_ENV` check that fires at
 * runtime, following TASK-020's block on `public/widget.js`: a runtime guard is
 * itself load-bearing code, and `next build` runs with
 * `NODE_ENV=production`, so it would have to be written carefully not to fire
 * during a build.
 *
 * **This can reject.** A hostname that will not parse, or an invalid
 * environment, throws — and neither is the customer's fault, so neither
 * becomes a `failure / UNKNOWN_ERROR` row that says their site did not comply
 * (owner's decision, 2026-09-27; PR #40 review, note 4). TASK-025 catches per
 * deployment and logs which hostname it was. Better no evidence than false
 * evidence.
 */
export async function fetchVerificationPage(hostname: string) {
  return fetchPage(hostname);
}

export {
  VERIFICATION_FETCH_BOUNDS,
  type VerificationFetchResult,
  type VerificationFetchSuccess,
} from "@/features/verification/fetch-page.internal";
