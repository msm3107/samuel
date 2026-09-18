import { describe, expect, it, vi } from "vitest";

import { withResponseFloor } from "@/lib/auth/sign-in/response-floor";
import { logger } from "@/lib/logging/logger";

/** A clock the test moves by hand, so no test waits in real time. */
function fakeClock(workTakesMs: number) {
  let now = 0;
  const slept: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      slept.push(ms);
      now += ms;
    },
    work:
      <T>(value: T) =>
      async () => {
        now += workTakesMs;
        return value;
      },
    failingWork: async () => {
      now += workTakesMs;
      throw new Error("auth server unavailable");
    },
    slept,
    elapsed: () => now,
  };
}

describe("withResponseFloor", () => {
  it("holds a fast answer until the floor plus its jitter", async () => {
    const clock = fakeClock(40);

    const result = await withResponseFloor(clock.work("link_sent"), {
      floorMs: 1200,
      jitterMs: 200,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0.5,
    });

    expect(result).toBe("link_sent");
    expect(clock.elapsed()).toBe(1300);
  });

  it("makes a fast and a slow path finish at the same moment", async () => {
    const fast = fakeClock(44);
    const slow = fakeClock(141);
    const options = { floorMs: 1200, jitterMs: 0, random: () => 0 };

    await withResponseFloor(fast.work("link_sent"), {
      ...options,
      now: fast.now,
      sleep: fast.sleep,
    });
    await withResponseFloor(slow.work("link_sent"), {
      ...options,
      now: slow.now,
      sleep: slow.sleep,
    });

    expect(fast.elapsed()).toBe(slow.elapsed());
  });

  it("still waits out the floor when the work fails, then rethrows", async () => {
    const clock = fakeClock(10);

    await expect(
      withResponseFloor(clock.failingWork, {
        floorMs: 1200,
        jitterMs: 0,
        now: clock.now,
        sleep: clock.sleep,
        random: () => 0,
      }),
    ).rejects.toThrow("auth server unavailable");
    expect(clock.elapsed()).toBe(1200);
  });

  it("logs when real work outlasts the floor, because the gap is visible again", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const clock = fakeClock(1500);

    await withResponseFloor(clock.work("link_sent"), {
      floorMs: 1200,
      jitterMs: 0,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
    });

    expect(clock.slept).toEqual([]);
    expect(warn).toHaveBeenCalledWith({
      event: "magic_link_response_floor_exceeded",
      floorMs: 1200,
      elapsedMs: 1500,
    });
  });
});
