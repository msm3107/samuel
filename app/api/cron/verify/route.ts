import { currentCheckWindow } from "@/features/verification/check-window";
import { fetchVerificationPage } from "@/features/verification/fetch-page";
import { inspectVerificationPage } from "@/features/verification/inspect-page";
import {
  runVerificationBatch,
  VERIFICATION_RUN,
} from "@/features/verification/run-verification";
import {
  readVerificationQueue,
  recordVerificationCheck,
} from "@/features/verification/verification-queries";
import {
  ApiRequestError,
  handleApiRequest,
  jsonResponse,
} from "@/lib/http/api";
import { logger } from "@/lib/logging/logger";
import { hasCronSecret } from "@/lib/security/cron-auth";

const ROUTE = "GET /api/cron/verify";

/**
 * The scheduled verifier (TASK-025; README §18, PLAN Phase 7).
 *
 * One tick: read the deployments due for a check in the current window, check
 * as many as the budget allows, and write one `verification_checks` row for
 * each. This is the only endpoint in the application that acts with the
 * service-role client on nobody's behalf — it reads across every tenant and
 * writes evidence customers rely on — so its only door is `CRON_SECRET`,
 * compared in constant time.
 *
 * **`GET`, with a side effect, deliberately.** Vercel Cron issues `GET` only.
 * The usual objection is about caches, prefetchers and crawlers replaying the
 * request, and none of them can: nothing happens without the secret, the
 * response is `no-store`, and a replay inside the same window is refused by
 * `unique (deployment_id, check_window)` rather than duplicated.
 *
 * **Nothing schedules it.** There is no `vercel.json` and no cron entry in this
 * repository (owner, 2026-09-27): merging this must not be the act that starts
 * fetching real customer sites. The operator adds the schedule when
 * verification should begin — hourly is the recommended cadence, against a
 * daily window, so that each tick drains part of the queue.
 */

export const dynamic = "force-dynamic";

/**
 * Longer than the run's own budget, so the summary is always written and
 * logged rather than the invocation being cut off with its work unaccounted
 * for.
 */
export const maxDuration = 60;

export async function GET(request: Request) {
  return handleApiRequest(ROUTE, async () => {
    if (!hasCronSecret(request)) {
      // The same refusal for an absent header, a malformed one and a wrong
      // secret. Which of the three it was is not a fact this endpoint owes
      // anybody, and the reference code in the body finds the log entry.
      throw new ApiRequestError(401, "authentication_required");
    }

    const checkWindow = currentCheckWindow();
    const due = await readVerificationQueue(
      checkWindow,
      VERIFICATION_RUN.batch,
    );

    const summary = await runVerificationBatch(due, checkWindow, {
      fetchPage: fetchVerificationPage,
      inspect: inspectVerificationPage,
      record: recordVerificationCheck,
    });

    // Phase 7's exit criterion: every run says what it did. A silent failure
    // here is a compliance failure the customer discovers months later.
    logger.info(
      { event: "verification_run_finished", ...summary },
      "A verification run finished",
    );

    // Counts, never hostnames. A scheduler's dashboard stores response bodies,
    // and which of our customers failed a check is not a fact for an external
    // product's log (README §34). The per-deployment detail is in the log
    // above, where §24's redaction and retention apply.
    return jsonResponse(summary);
  });
}
