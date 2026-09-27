import { z } from "zod";

/**
 * Which window a check belongs to (TASK-025).
 *
 * A window is one UTC day (owner, 2026-09-27). The length is not a scheduling
 * detail: `verification_checks` is never pruned and carries
 * `unique (deployment_id, check_window)`, so the window length *is* the
 * storage policy — 365 rows per active deployment per year, against hourly's
 * 8 760, kept for the life of the organization.
 *
 * UTC rather than an organization's local day, because a window is our
 * schedule's bucket rather than a date a customer reads. A per-tenant boundary
 * would make one deployment's window depend on data the queue would then have
 * to join, for no gain to anybody.
 *
 * **The window is not the schedule.** A daily window with one daily tick would
 * leave everything past a run's batch cap unchecked until the next day. Any
 * number of ticks inside one window is correct and drains the queue, because a
 * deployment that has a row for the window is no longer in it. The recommended
 * cadence is hourly; the schedule is configured deliberately rather than
 * shipped in this repository (owner, 2026-09-27).
 */

/** How long a window lasts, as the queue and the schedule both read it. */
export const CHECK_WINDOW = Object.freeze({
  /** One UTC day. */
  label: "daily",
  /** Recommended ticks per window, for the schedule the operator adds. */
  recommendedCron: "0 * * * *",
});

/**
 * The start of the window `now` falls in, as the database stores it.
 *
 * Truncating to the UTC day is done on the date parts rather than by
 * arithmetic on the epoch, so it stays correct whatever the host's zone is
 * set to — a run on a machine in `Europe/Warsaw` must bucket a check the same
 * way as one in UTC, or two ticks of the same window would write two rows.
 */
export function currentCheckWindow(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/**
 * A window as the database returns it. Validated like any other external
 * input: the column is `timestamptz not null` with
 * `check (check_window <= checked_at)`, so anything else means the table
 * changed under the application.
 */
export const checkWindowSchema = z.iso.datetime({ offset: true });
