/**
 * A best-effort budget on how often one kind of work may be done, counted in
 * this process alone (PR #36 review, notes 2 and 4).
 *
 * It exists because two paths on the public endpoint would otherwise cost
 * more the busier things get: past the service-wide ceiling every request
 * would spend a third rate-limit bucket write, and during a database outage
 * every request would write a log entry. Both are bounded here instead, so
 * the load and the logging bill do not rise with the flood that caused them.
 *
 * Deliberately not the rate limiter: this must cost nothing, and a limiter
 * call is a database write — the thing being bounded.
 *
 * What it is not:
 *
 * - **Not a guarantee.** State is per process, so each serverless instance
 *   spends its own budget, and a cold start resets it. During an incident
 *   "once per window per instance" is arguably the more useful signal
 *   anyway; where a hard global bound matters, a rate-limit bucket still
 *   decides, with this only keeping the call off the hot path.
 * - **Not a cache.** Keys must be constants from the calling module, never
 *   anything from a request, both because the map is never pruned and
 *   because a key built from input would make a caller's data outlive the
 *   request.
 */
const lastSpent = new Map<string, number>();

/**
 * True at most once per `windowSeconds` for `key` in this process. Calling it
 * spends the window whether or not the caller then does the work, which is
 * the point: the cost being avoided is the attempt.
 */
export function oncePerWindow(key: string, windowSeconds: number): boolean {
  const now = Date.now();
  const spent = lastSpent.get(key);
  if (spent !== undefined && now - spent < windowSeconds * 1000) {
    return false;
  }
  lastSpent.set(key, now);
  return true;
}
