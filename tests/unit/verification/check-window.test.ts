import { describe, expect, it } from "vitest";

import {
  CHECK_WINDOW,
  checkWindowSchema,
  currentCheckWindow,
} from "@/features/verification/check-window";

/**
 * The window a check belongs to (TASK-025).
 *
 * The boundary is worth its own tests because it is the idempotency: two ticks
 * that disagree about which window they are in write two rows for one day,
 * into a table nothing can clean up.
 */

describe("currentCheckWindow", () => {
  it.each([
    ["2026-09-27T00:00:00.000Z", "2026-09-27T00:00:00.000Z"],
    ["2026-09-27T00:00:00.001Z", "2026-09-27T00:00:00.000Z"],
    ["2026-09-27T12:34:56.789Z", "2026-09-27T00:00:00.000Z"],
    ["2026-09-27T23:59:59.999Z", "2026-09-27T00:00:00.000Z"],
    ["2026-09-28T00:00:00.000Z", "2026-09-28T00:00:00.000Z"],
  ])("puts %s in the window starting %s", (now, expected) => {
    expect(currentCheckWindow(new Date(now)).toISOString()).toBe(expected);
  });

  it("agrees across every hour of a day, so a day has one window", () => {
    const windows = new Set(
      Array.from({ length: 24 }, (_, hour) =>
        currentCheckWindow(
          new Date(Date.UTC(2026, 8, 27, hour, 30, 15)),
        ).toISOString(),
      ),
    );

    expect([...windows]).toEqual(["2026-09-27T00:00:00.000Z"]);
  });

  it("crosses a month, a year and a leap day on the right boundary", () => {
    expect(
      currentCheckWindow(new Date("2026-12-31T23:59:59Z")).toISOString(),
    ).toBe("2026-12-31T00:00:00.000Z");
    expect(
      currentCheckWindow(new Date("2027-01-01T00:00:00Z")).toISOString(),
    ).toBe("2027-01-01T00:00:00.000Z");
    expect(
      currentCheckWindow(new Date("2028-02-29T09:00:00Z")).toISOString(),
    ).toBe("2028-02-29T00:00:00.000Z");
  });

  it("buckets by UTC, not by the host's zone", () => {
    // A run on a machine in Europe/Warsaw must bucket a check the same way as
    // one in UTC. 01:30 in Warsaw on the 28th is 23:30 UTC on the 27th, and
    // the window is the 27th.
    expect(
      currentCheckWindow(new Date("2026-09-27T23:30:00Z")).toISOString(),
    ).toBe("2026-09-27T00:00:00.000Z");
  });

  it("is a window the database column accepts", () => {
    expect(
      checkWindowSchema.safeParse(currentCheckWindow().toISOString()).success,
    ).toBe(true);
  });

  it("names a cadence that ticks more often than the window", () => {
    // A daily window with one daily tick would leave everything past a run's
    // batch cap unchecked until the next day. The queue drains because a
    // deployment with a row for the window is no longer in it.
    expect(CHECK_WINDOW.label).toBe("daily");
    expect(CHECK_WINDOW.recommendedCron).toBe("0 * * * *");
  });
});
