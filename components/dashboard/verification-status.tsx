import { CHECK_STATUS_LABELS } from "@/app/(dashboard)/dashboard/[organizationId]/deployments/[deploymentId]/checks/messages";
import type { VerificationStatus } from "@/features/verification/verification-check";

/**
 * Whether a check passed (TASK-027), in three channels and in this order of
 * authority: the word, the shape, the colour.
 *
 * §35 forbids status by colour alone. The word is the status — a reader with a
 * monochrome screen, a screen reader, or the commonest colour-vision
 * deficiency loses nothing, because the colour is never the only difference and
 * the two shapes have different silhouettes rather than different fills. Green
 * and red are the worst pair there is for exactly that deficiency, which is why
 * they are the channel that carries the least here.
 *
 * The shape is `aria-hidden`: it repeats the word beside it, and a screen
 * reader announcing "tick, Passed" would be reading the decoration twice.
 */
export function VerificationStatusBadge({
  status,
}: {
  status: VerificationStatus;
}) {
  const passed = status === "success";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-sm font-medium ${
        passed
          ? "border-emerald-700 text-emerald-900"
          : "border-red-700 text-red-900"
      }`}
    >
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 16 16"
        className="h-3.5 w-3.5 shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {passed ? (
          <path d="M3 8.5 6.5 12 13 4" />
        ) : (
          <path d="M4 4l8 8M12 4l-8 8" />
        )}
      </svg>
      {CHECK_STATUS_LABELS[status]}
    </span>
  );
}
