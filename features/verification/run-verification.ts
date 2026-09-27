import "server-only";

import {
  VERIFICATION_FETCH_BOUNDS,
  type VerificationFetchResult,
  type VerificationFetchSuccess,
} from "@/features/verification/fetch-page";
import type { PageInspection } from "@/features/verification/inspect-page";
import type {
  VerificationCheckRecord,
  VerificationQueueRow,
} from "@/features/verification/verification-queries";
import { logger } from "@/lib/logging/logger";

/**
 * Running a batch of checks (TASK-025).
 *
 * This is where TASK-023's fetch and TASK-024's inspection become evidence.
 * Everything it does is bounded, because the thing it is doing is making
 * requests to other people's websites on a schedule:
 *
 * - **A batch**, because the queue can be longer than one invocation.
 * - **A wall-clock budget**, because one slow target costs fifteen seconds and
 *   a serverless invocation has a ceiling. A run that stops early leaves the
 *   deployments it did not reach with no row for the window, which is exactly
 *   the queue's definition of work to do; a run that dies mid-flight leaves
 *   work nobody can see.
 * - **A concurrency cap**, and **one fetch in flight per hostname** — a
 *   customer may point many deployments at one host, and fifty simultaneous
 *   requests from our addresses is a burst that host may reasonably treat as an
 *   attack, whereupon its 429 would be recorded as that customer's
 *   `HTTP_ERROR`. All three chosen by the owner, 2026-09-27.
 *
 * It is a pure function of its batch and three injected capabilities, so the
 * budget, the ordering and the row it writes are all tested without a network
 * or a database.
 */

export const VERIFICATION_RUN = Object.freeze({
  /**
   * The most deployments one invocation will ask the queue for. The budget
   * below is the real limit; this bounds the query rather than the work.
   */
  batch: 200,
  /** Fetches in flight at once, across all hosts. */
  concurrency: 4,
  /**
   * Wall clock for the whole run. Comfortably inside the route's
   * `maxDuration`, so the summary is always written and logged rather than the
   * invocation being cut off with its work unaccounted for.
   */
  budgetMs: 50_000,
});

/** What one finished run reports. Counts only — see the route. */
export type VerificationRunSummary = Readonly<{
  /** The window every row was written for. */
  window: string;
  /** Deployments the queue handed this run. */
  considered: number;
  /** Rows written saying the notice was found. */
  succeeded: number;
  /** Rows written saying it was not, for a reason about the customer's site. */
  failed: number;
  /** Another tick of this window had already recorded the deployment. */
  duplicate: number;
  /**
   * Deployments where our own code threw. No row was written, deliberately —
   * see below. Any number above zero is a bug of ours, not a customer's.
   */
  errored: number;
  /** Left in the queue: the budget ran out before the run reached them. */
  remaining: number;
}>;

export type VerificationRunDependencies = Readonly<{
  fetchPage: (hostname: string) => Promise<VerificationFetchResult>;
  inspect: (page: VerificationFetchSuccess, publicId: string) => PageInspection;
  /** Returns false when the row already existed: the idempotency working. */
  record: (record: VerificationCheckRecord) => Promise<boolean>;
  now?: () => number;
}>;

/**
 * Turns one finished check into the row it should become.
 *
 * The three shapes the database's own coherence rules allow: a success carries
 * a status and a found widget, a transport failure carries whatever the server
 * managed to say, and an inspection failure carries the observation that
 * produced it — `widgetDetected: true` included, when the script was present
 * and its identifier was not ours.
 */
function toRecord(
  row: VerificationQueueRow,
  checkWindow: Date,
  outcome:
    | Readonly<{
        kind: "transport";
        page: Extract<VerificationFetchResult, { ok: false }>;
      }>
    | Readonly<{
        kind: "inspected";
        page: VerificationFetchSuccess;
        inspection: PageInspection;
      }>,
): VerificationCheckRecord {
  const identity = {
    organizationId: row.organization_id,
    deploymentId: row.deployment_id,
    disclosureId: row.disclosure_id,
    checkWindow,
  } as const;

  if (outcome.kind === "transport") {
    return {
      ...identity,
      status: "failure",
      failureCode: outcome.page.code,
      httpStatus: outcome.page.httpStatus,
      // Nothing was inspected. Null is "not observed", which is a different
      // claim from false.
      widgetDetected: null,
      metadata: outcome.page.metadata,
    };
  }

  const { inspection } = outcome;
  return {
    ...identity,
    status: inspection.ok ? "success" : "failure",
    failureCode: inspection.ok ? null : inspection.code,
    httpStatus: outcome.page.httpStatus,
    widgetDetected: inspection.widgetDetected,
    metadata: inspection.metadata,
  };
}

/** Deployments grouped by hostname, each group to be checked one at a time. */
function chainsByHost(
  rows: readonly VerificationQueueRow[],
): VerificationQueueRow[][] {
  const chains = new Map<string, VerificationQueueRow[]>();
  for (const row of rows) {
    const chain = chains.get(row.hostname);
    if (chain === undefined) {
      chains.set(row.hostname, [row]);
    } else {
      chain.push(row);
    }
  }
  return [...chains.values()];
}

/**
 * Checks every deployment in `rows` it has budget for, writing one row each.
 *
 * @param checkWindow The window every row is written for. The run's clock
 *   decides it; `checked_at` is the database's, because a job's clock is not
 *   evidence.
 */
export async function runVerificationBatch(
  rows: readonly VerificationQueueRow[],
  checkWindow: Date,
  dependencies: VerificationRunDependencies,
): Promise<VerificationRunSummary> {
  const now = dependencies.now ?? Date.now;
  const deadline = now() + VERIFICATION_RUN.budgetMs;

  let succeeded = 0;
  let failed = 0;
  let duplicate = 0;
  let errored = 0;

  /**
   * A fetch is started only while a whole fetch budget remains, so every fetch
   * this run begins can finish honestly rather than being cut off into an
   * `UNKNOWN_ERROR` that says nothing about the customer's site. The bound is
   * imported from the fetch rather than restated, for the reason the
   * inspection imports `WIDGET_PATH`.
   */
  const hasBudget = () => now() < deadline - VERIFICATION_FETCH_BOUNDS.totalMs;

  async function check(row: VerificationQueueRow): Promise<void> {
    try {
      const page = await dependencies.fetchPage(row.hostname);
      const record = toRecord(
        row,
        checkWindow,
        page.ok
          ? {
              kind: "inspected",
              page,
              inspection: dependencies.inspect(page, row.public_id),
            }
          : { kind: "transport", page },
      );

      if (!(await dependencies.record(record))) {
        duplicate += 1;
        return;
      }
      if (record.status === "success") {
        succeeded += 1;
        return;
      }
      failed += 1;
      logger.info(
        {
          event: "verification_check_failed",
          // Not `hostname`: pino puts the *machine's* hostname on every
          // record, and a second key of that name makes one of the two
          // unreadable. This one is the customer's host.
          targetHostname: row.hostname,
          deploymentId: row.deployment_id,
          failureCode: record.failureCode,
          widgetReason: record.metadata.widget_reason,
        },
        "A verification check recorded a failure",
      );
    } catch (error) {
      // **No row.** The fetch and the inspection reject only when the fault is
      // ours — a hostname that will not parse, an invalid environment, an
      // identifier that is not one, a database that refused — and every one of
      // those was validated long before this ran (PR #40 review, note 4; owner,
      // 2026-09-27). Writing `failure / UNKNOWN_ERROR` would blame a customer
      // for our bug, in an append-only record that never expires.
      //
      // So the deployment stays in the queue and the next tick of this window
      // tries again, and the log says which hostname it was. Better no
      // evidence than false evidence.
      errored += 1;
      logger.error(
        {
          event: "verification_check_errored",
          // See above: pino owns `hostname`.
          targetHostname: row.hostname,
          deploymentId: row.deployment_id,
          errorName: error instanceof Error ? error.name : "unknown",
        },
        "A verification check could not be completed",
      );
    }
  }

  const chains = chainsByHost(rows);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const chain = chains[next];
      if (chain === undefined) {
        return;
      }
      next += 1;
      for (const row of chain) {
        if (!hasBudget()) {
          return;
        }
        await check(row);
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(VERIFICATION_RUN.concurrency, chains.length) },
      () => worker(),
    ),
  );

  return Object.freeze({
    window: checkWindow.toISOString(),
    considered: rows.length,
    succeeded,
    failed,
    duplicate,
    errored,
    // Whatever was not accounted for was not reached: the budget ran out, and
    // these have no row for the window, so the next tick takes them.
    remaining: rows.length - (succeeded + failed + duplicate + errored),
  });
}
