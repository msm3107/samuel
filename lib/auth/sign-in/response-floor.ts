import { logger } from "@/lib/logging/logger";

/**
 * Real GoTrue answers a magic-link request measurably faster for an address
 * that already has an account than for one it must create (about 44 ms against
 * 141 ms locally, with no overlap). Answering every request after the same
 * fixed floor, plus jitter, hides that difference from anyone timing the
 * response.
 *
 * The floor must stay above the slowest normal path. If real work ever
 * exceeds it, the difference shows again, so that is logged for operators.
 * The per-address and per-IP rate limits (TASK-003c) keep the number of
 * samples an attacker can collect far below what a residual gap would need.
 */
export const MAGIC_LINK_RESPONSE_FLOOR_MS = 1200;
export const MAGIC_LINK_RESPONSE_JITTER_MS = 200;

type ResponseFloorOptions = {
  floorMs?: number;
  jitterMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withResponseFloor<T>(
  work: () => Promise<T>,
  {
    floorMs = MAGIC_LINK_RESPONSE_FLOOR_MS,
    jitterMs = MAGIC_LINK_RESPONSE_JITTER_MS,
    sleep = defaultSleep,
    now = () => performance.now(),
    random = Math.random,
  }: ResponseFloorOptions = {},
): Promise<T> {
  const started = now();
  const target = floorMs + random() * jitterMs;

  try {
    return await work();
  } finally {
    // Also on failure: an error that answers early would be its own signal.
    const elapsed = now() - started;
    if (elapsed < target) {
      await sleep(target - elapsed);
    } else {
      logger.warn({
        event: "magic_link_response_floor_exceeded",
        floorMs,
        elapsedMs: Math.round(elapsed),
      });
    }
  }
}
