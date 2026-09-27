import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { VERIFICATION_FETCH_BOUNDS } from "@/features/verification/fetch-page";
import type { VerificationFetchResult } from "@/features/verification/fetch-page";
import type { PageInspection } from "@/features/verification/inspect-page";
import {
  runVerificationBatch,
  VERIFICATION_RUN,
} from "@/features/verification/run-verification";
import type {
  VerificationCheckRecord,
  VerificationQueueRow,
} from "@/features/verification/verification-queries";

/**
 * The run (TASK-025): what one tick does with a batch.
 *
 * No network and no database — the fetch, the inspection and the write are all
 * injected, which is what lets the budget, the ordering and the row itself be
 * asserted rather than described. The things worth proving here are the ones
 * that would otherwise only show up in production: that one deployment cannot
 * stop the rest, that a fault of ours writes no row, and that running out of
 * budget leaves work in the queue instead of losing it.
 */

const WINDOW = new Date("2026-09-27T00:00:00.000Z");

let written: VerificationCheckRecord[];
let clock: number;

beforeEach(() => {
  written = [];
  clock = 0;
});

function row(
  hostname: string,
  overrides: Partial<VerificationQueueRow> = {},
): VerificationQueueRow {
  return {
    organization_id: "00000000-0000-4000-8000-00000000a001",
    deployment_id: `00000000-0000-4000-8000-${hostname.slice(0, 4).padStart(12, "0")}`,
    disclosure_id: "00000000-0000-4000-8000-00000000d001",
    hostname,
    public_id: "dep_7k2m4qphr6vt3wzc5nxa7jd2fb",
    ...overrides,
  };
}

const found: PageInspection = {
  ok: true,
  widgetDetected: true,
  disclosureVersion: null,
  metadata: { widget_tags: 1, charset: "utf-8" },
};

const missing: PageInspection = {
  ok: false,
  code: "WIDGET_NOT_FOUND",
  widgetDetected: false,
  disclosureVersion: null,
  reason: "NO_WIDGET_TAG",
  metadata: {
    widget_tags: 0,
    charset: "utf-8",
    widget_reason: "NO_WIDGET_TAG",
  },
};

function answered(httpStatus = 200): VerificationFetchResult {
  return {
    ok: true,
    httpStatus,
    finalUrl: "https://shop.example.com/",
    body: Buffer.from("<html></html>"),
    metadata: { scheme: "https", https_failed: false, redirects: 0 },
  };
}

function refused(
  code: "DNS_ERROR" | "CONNECTION_FAILED" = "DNS_ERROR",
): VerificationFetchResult {
  return {
    ok: false,
    code,
    httpStatus: null,
    reason: null,
    metadata: { scheme: "https", https_failed: true },
  };
}

/** The default wiring: everything answers, the widget is found, writes win. */
function dependencies(
  overrides: Partial<Parameters<typeof runVerificationBatch>[2]> = {},
) {
  return {
    fetchPage: async () => answered(),
    inspect: () => found,
    record: async (record: VerificationCheckRecord) => {
      written.push(record);
      return true;
    },
    now: () => clock,
    ...overrides,
  };
}

describe("what a run records", () => {
  it("writes a success for a deployment whose notice is found", async () => {
    const summary = await runVerificationBatch(
      [row("shop.example.com")],
      WINDOW,
      dependencies(),
    );

    expect(summary).toMatchObject({ considered: 1, succeeded: 1, failed: 0 });
    expect(written[0]).toMatchObject({
      status: "success",
      failureCode: null,
      httpStatus: 200,
      widgetDetected: true,
      checkWindow: WINDOW,
    });
  });

  it("writes the inspection's failure, and what it observed", async () => {
    await runVerificationBatch(
      [row("shop.example.com")],
      WINDOW,
      dependencies({ inspect: () => missing }),
    );

    expect(written[0]).toMatchObject({
      status: "failure",
      failureCode: "WIDGET_NOT_FOUND",
      httpStatus: 200,
      widgetDetected: false,
      metadata: { widget_reason: "NO_WIDGET_TAG" },
    });
  });

  it("records widget_detected true beside a failure when the script was there", async () => {
    // README §18 asks two questions, and this is the honest pair of answers.
    const mismatch: PageInspection = {
      ok: false,
      code: "DEPLOYMENT_ID_MISMATCH",
      widgetDetected: true,
      disclosureVersion: null,
      reason: "OTHER_DEPLOYMENT",
      metadata: { widget_tags: 1 },
    };

    await runVerificationBatch(
      [row("shop.example.com")],
      WINDOW,
      dependencies({ inspect: () => mismatch }),
    );

    expect(written[0]).toMatchObject({
      status: "failure",
      failureCode: "DEPLOYMENT_ID_MISMATCH",
      widgetDetected: true,
    });
  });

  it("writes a transport failure with nothing observed rather than false", async () => {
    await runVerificationBatch(
      [row("gone.example.com")],
      WINDOW,
      dependencies({ fetchPage: async () => refused() }),
    );

    expect(written[0]).toMatchObject({
      status: "failure",
      failureCode: "DNS_ERROR",
      httpStatus: null,
      // Null is "not observed". False would claim we looked at a page.
      widgetDetected: null,
    });
  });

  it("never writes a disclosure version or a hash", async () => {
    // TASK-024 cannot observe a version, and §20's chain is still unwritten.
    await runVerificationBatch(
      [row("shop.example.com")],
      WINDOW,
      dependencies(),
    );

    expect(Object.keys(written[0] ?? {})).not.toContain("disclosureVersion");
    expect(Object.keys(written[0] ?? {})).not.toContain("payloadHash");
  });

  it("does not inspect a page that was never fetched", async () => {
    const inspect = vi.fn(() => found);

    await runVerificationBatch(
      [row("gone.example.com")],
      WINDOW,
      dependencies({ fetchPage: async () => refused(), inspect }),
    );

    expect(inspect).not.toHaveBeenCalled();
  });
});

describe("when the fault is ours", () => {
  it("writes no row at all, and counts it as ours", async () => {
    // PR #40 review, note 4: both the fetch and the inspection reject only
    // when the fault is ours, and a `failure / UNKNOWN_ERROR` row would blame
    // a customer for our bug in evidence that never expires.
    const summary = await runVerificationBatch(
      [row("shop.example.com")],
      WINDOW,
      dependencies({
        fetchPage: async () => {
          throw new TypeError("A hostname is required");
        },
      }),
    );

    expect(written).toEqual([]);
    expect(summary).toMatchObject({ errored: 1, failed: 0, succeeded: 0 });
  });

  it("leaves that deployment in the queue, so the next tick retries it", async () => {
    // Nothing was written, which is precisely what keeps it in the queue: the
    // queue is the absence of a row.
    const summary = await runVerificationBatch(
      [row("shop.example.com")],
      WINDOW,
      dependencies({
        inspect: () => {
          throw new TypeError("A public deployment identifier is required");
        },
      }),
    );

    expect(written).toEqual([]);
    expect(summary.errored).toBe(1);
  });

  it("checks the others anyway", async () => {
    const summary = await runVerificationBatch(
      [row("a.example.com"), row("bad.example.com"), row("c.example.com")],
      WINDOW,
      dependencies({
        fetchPage: async (hostname: string) => {
          if (hostname === "bad.example.com") {
            throw new Error("boom");
          }
          return answered();
        },
      }),
    );

    expect(summary).toMatchObject({ considered: 3, succeeded: 2, errored: 1 });
  });

  it("survives a write that fails for a reason other than a duplicate", async () => {
    const summary = await runVerificationBatch(
      [row("a.example.com"), row("b.example.com")],
      WINDOW,
      dependencies({
        record: async (record: VerificationCheckRecord) => {
          if (record.deploymentId.endsWith("a.ex")) {
            throw new Error("the database refused");
          }
          written.push(record);
          return true;
        },
      }),
    );

    expect(summary).toMatchObject({ succeeded: 1, errored: 1 });
  });
});

describe("what a run says in the log", () => {
  /**
   * PR #40 note 4 requires the scheduler to log which hostname it was, and the
   * first version of this module put it under `hostname` — which pino already
   * uses for the *machine's* name on every record. The line came out with two
   * keys of that name, one of which a reader or a log pipeline would drop. The
   * requirement is only met if the key survives.
   */
  it("names the customer's host under a key pino does not own", async () => {
    const { logger } = await import("@/lib/logging/logger");
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});

    await runVerificationBatch(
      [row("shop.example.com")],
      WINDOW,
      dependencies({
        fetchPage: async () => {
          throw new TypeError("A hostname is required");
        },
      }),
    );

    expect(error).toHaveBeenCalledTimes(1);
    const payload = error.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      event: "verification_check_errored",
      targetHostname: "shop.example.com",
    });
    expect(payload).not.toHaveProperty("hostname");
  });

  it("says which failure and which reason a recorded failure had", async () => {
    const { logger } = await import("@/lib/logging/logger");
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});

    await runVerificationBatch(
      [row("shop.example.com")],
      WINDOW,
      dependencies({ inspect: () => missing }),
    );

    expect(info.mock.calls[0]?.[0]).toMatchObject({
      event: "verification_check_failed",
      targetHostname: "shop.example.com",
      failureCode: "WIDGET_NOT_FOUND",
      widgetReason: "NO_WIDGET_TAG",
    });
  });
});

describe("idempotency", () => {
  it("counts a row another tick already wrote, and does not fail the run", async () => {
    const summary = await runVerificationBatch(
      [row("a.example.com"), row("b.example.com")],
      WINDOW,
      dependencies({ record: async () => false }),
    );

    expect(summary).toMatchObject({
      considered: 2,
      duplicate: 2,
      succeeded: 0,
      remaining: 0,
    });
  });

  it("writes every row for the window it was given", async () => {
    await runVerificationBatch(
      [row("a.example.com"), row("b.example.com")],
      WINDOW,
      dependencies(),
    );

    expect(written.map((record) => record.checkWindow)).toEqual([
      WINDOW,
      WINDOW,
    ]);
  });
});

describe("the budget", () => {
  it("leaves the deployments it could not reach in the queue", async () => {
    // Each fetch costs a whole fetch budget on the fake clock, so the run
    // stops with work left rather than running past its own ceiling.
    const rows = Array.from({ length: 10 }, (_, index) =>
      row(`h${index}.example.com`),
    );
    const summary = await runVerificationBatch(rows, WINDOW, {
      ...dependencies(),
      fetchPage: async () => {
        clock += VERIFICATION_FETCH_BOUNDS.totalMs;
        return answered();
      },
    });

    expect(summary.considered).toBe(10);
    expect(summary.remaining).toBeGreaterThan(0);
    expect(summary.succeeded + summary.remaining).toBe(10);
    // And it did do some work: stopping early is not the same as doing nothing.
    expect(summary.succeeded).toBeGreaterThan(0);
  });

  it("starts nothing once less than one whole fetch budget remains", async () => {
    // A fetch the run cannot let finish would be cut off into an UNKNOWN_ERROR
    // that says nothing about the customer's site.
    //
    // The clock has to move for this to mean anything: the deadline is taken
    // from the first reading, so the run is only out of budget once time has
    // actually passed. The first call sets the deadline; every later one is
    // one millisecond past the last moment a fetch could still finish.
    let readings = 0;
    const now = () =>
      readings++ === 0
        ? 0
        : VERIFICATION_RUN.budgetMs - VERIFICATION_FETCH_BOUNDS.totalMs + 1;
    const fetchPage = vi.fn(async () => answered());

    const summary = await runVerificationBatch([row("a.example.com")], WINDOW, {
      ...dependencies(),
      fetchPage,
      now,
    });

    expect(fetchPage).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ considered: 1, remaining: 1 });
  });

  it("checks everything when there is budget for it", async () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      row(`h${index}.example.com`),
    );

    const summary = await runVerificationBatch(rows, WINDOW, dependencies());

    expect(summary).toMatchObject({
      considered: 12,
      succeeded: 12,
      remaining: 0,
    });
  });
});

describe("politeness to a single host", () => {
  it("never has two fetches in flight for one hostname", async () => {
    // A customer may point many deployments at one host. Fifty simultaneous
    // requests from our addresses is a burst that host may treat as an attack,
    // and its 429 would be recorded as that customer's HTTP_ERROR.
    let inFlight = 0;
    let worst = 0;
    const rows = Array.from({ length: 8 }, (_, index) =>
      row("busy.example.com", {
        deployment_id: `00000000-0000-4000-8000-00000000b0${index}0`,
      }),
    );

    await runVerificationBatch(rows, WINDOW, {
      ...dependencies(),
      fetchPage: async () => {
        inFlight += 1;
        worst = Math.max(worst, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return answered();
      },
    });

    expect(worst).toBe(1);
    expect(written).toHaveLength(8);
  });

  it("still runs different hosts at the same time", async () => {
    let inFlight = 0;
    let worst = 0;
    const rows = Array.from({ length: 8 }, (_, index) =>
      row(`h${index}.example.com`),
    );

    await runVerificationBatch(rows, WINDOW, {
      ...dependencies(),
      fetchPage: async () => {
        inFlight += 1;
        worst = Math.max(worst, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return answered();
      },
    });

    expect(worst).toBeGreaterThan(1);
    // And never more than the cap.
    expect(worst).toBeLessThanOrEqual(VERIFICATION_RUN.concurrency);
  });

  it("does nothing, and says so, for an empty queue", async () => {
    const summary = await runVerificationBatch([], WINDOW, dependencies());

    expect(summary).toMatchObject({
      considered: 0,
      succeeded: 0,
      failed: 0,
      remaining: 0,
      window: WINDOW.toISOString(),
    });
  });
});
