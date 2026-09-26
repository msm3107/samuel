import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { oncePerWindow } from "@/lib/logging/once-per-window";

/**
 * The per-process budget behind the public endpoint's ceiling alert and its
 * fault log (PR #36 review, notes 2 and 4). It has to be cheap and it has to
 * reopen: a bound that never reopened would silence an outage after its
 * first minute.
 */

let clock = Date.UTC(2026, 8, 26, 12);

beforeEach(() => {
  // Every test gets its own hour: the map is module state on purpose.
  clock += 3_600_000;
  vi.useFakeTimers({ toFake: ["Date"], now: clock });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("oncePerWindow", () => {
  it("is true the first time and false for the rest of the window", () => {
    expect(oncePerWindow("a", 60)).toBe(true);
    expect(oncePerWindow("a", 60)).toBe(false);
    vi.setSystemTime(clock + 59_999);
    expect(oncePerWindow("a", 60)).toBe(false);
  });

  it("reopens once the window has passed", () => {
    expect(oncePerWindow("b", 60)).toBe(true);
    vi.setSystemTime(clock + 60_000);
    expect(oncePerWindow("b", 60)).toBe(true);
  });

  it("measures the window from the last true, not from the first", () => {
    // Otherwise a steady stream would earn an entry on a fixed schedule
    // regardless of how often it was asked.
    expect(oncePerWindow("c", 60)).toBe(true);
    vi.setSystemTime(clock + 60_000);
    expect(oncePerWindow("c", 60)).toBe(true);
    vi.setSystemTime(clock + 119_000);
    expect(oncePerWindow("c", 60)).toBe(false);
  });

  it("keeps one budget per key", () => {
    expect(oncePerWindow("d", 60)).toBe(true);
    // A different fault code, or a different alert, must not be swallowed
    // by the first one's window.
    expect(oncePerWindow("e", 60)).toBe(true);
    expect(oncePerWindow("d", 60)).toBe(false);
  });

  it("spends the window on the attempt, not on the work", () => {
    // The caller may well decide to do nothing after a true; the cost being
    // avoided is the attempt itself, so the window is spent either way.
    expect(oncePerWindow("f", 300)).toBe(true);
    expect(oncePerWindow("f", 300)).toBe(false);
  });
});
