"use client";

import { useActionState, useId, type FormEvent } from "react";

import {
  DEPLOYMENT_STATUS_MESSAGES,
  isStatusProblem,
  type DeploymentStatusState,
} from "@/app/(dashboard)/dashboard/[organizationId]/deployments/messages";
import { SECONDARY_BUTTON } from "@/components/ui/styles";

type DeploymentStatusFormProps = {
  /** A server action, already bound to its organization, deployment and status. */
  action: (
    state: DeploymentStatusState,
    formData: FormData,
  ) => Promise<DeploymentStatusState>;
  label: string;
  pendingLabel: string;
  /** What the button does, in a sentence or two, for screen readers and sight. */
  explanation: string;
  /**
   * Why the change can't be made now, shown instead of the button (a
   * restore under an archived AI system, which the database refuses
   * anyway). The live region stays, so an archive that led here is still
   * announced.
   */
  unavailable?: string | undefined;
};

/**
 * Archives or restores one deployment (TASK-015): one button, no
 * confirmation, as for AI systems (owner, 2026-09-22). Restoring undoes an
 * archive, with the same public ID, and both are audited. The result is
 * announced in a live region that stays mounted when the page re-renders
 * with the new status.
 *
 * TASK-010's `AiSystemStatusForm` does the same for systems. It is not
 * shared, because telling a success from a refusal would have to be passed
 * in from a server component, which can pass only data.
 */
export function DeploymentStatusForm({
  action,
  label,
  pendingLabel,
  explanation,
  unavailable,
}: DeploymentStatusFormProps) {
  const [state, formAction, isPending] = useActionState(action, null);
  const explanationId = useId();

  const statusText = isPending
    ? pendingLabel
    : state
      ? `${isStatusProblem(state.result) ? "Problem: " : ""}${DEPLOYMENT_STATUS_MESSAGES[state.result]}`
      : "";

  function preventRepeatSubmit(event: FormEvent<HTMLFormElement>) {
    if (isPending) {
      event.preventDefault();
    }
  }

  return (
    <form
      action={formAction}
      onSubmit={preventRepeatSubmit}
      aria-busy={isPending}
      className="space-y-3"
    >
      <p id={explanationId} className="text-sm text-slate-700">
        {unavailable ?? explanation}
      </p>
      {unavailable === undefined ? (
        <button
          type="submit"
          aria-disabled={isPending}
          aria-describedby={explanationId}
          className={SECONDARY_BUTTON}
        >
          {isPending ? pendingLabel : label}
        </button>
      ) : null}
      <p
        role="status"
        aria-live="polite"
        className={
          statusText
            ? `rounded-md border px-3 py-2 text-sm ${
                state && isStatusProblem(state.result) && !isPending
                  ? "border-red-300 bg-red-50 text-red-900"
                  : "border-slate-300 bg-slate-50 text-slate-900"
              }`
            : "sr-only"
        }
      >
        {statusText}
      </p>
    </form>
  );
}
