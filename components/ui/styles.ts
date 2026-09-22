/**
 * Class lists shared by the dashboard's controls (TASK-010). Written out in
 * full, so Tailwind finds them in this file.
 */

/** The outline every link, button and input shows when focused by keyboard. */
export const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900";

export const PRIMARY_BUTTON = `rounded-md bg-slate-900 px-4 py-2 font-medium text-white aria-disabled:cursor-not-allowed ${FOCUS_RING}`;

export const SECONDARY_BUTTON = `rounded-md border border-slate-500 px-4 py-2 font-medium aria-disabled:cursor-not-allowed ${FOCUS_RING}`;

export const TEXT_INPUT = `w-full rounded-md border border-slate-500 px-3 py-2 ${FOCUS_RING}`;

export const TEXT_LINK = `font-medium text-slate-900 underline underline-offset-2 ${FOCUS_RING}`;
