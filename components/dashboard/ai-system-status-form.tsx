"use client";

import { useActionState, useId, type FormEvent } from "react";

import {
  AI_SYSTEM_STATUS_MESSAGES,
  isProblem,
  type AiSystemStatusState,
} from "@/app/(dashboard)/dashboard/[organizationId]/systems/messages";
import { SECONDARY_BUTTON } from "@/components/ui/styles";

type AiSystemStatusFormProps = {
  /** A server action, already bound to its organization, system and status. */
  action: (
    state: AiSystemStatusState,
    formData: FormData,
  ) => Promise<AiSystemStatusState>;
  label: string;
  pendingLabel: string;
  /** What the button does, in a sentence, for screen readers and sight. */
  explanation: string;
};

/**
 * Archives or restores one system (TASK-010): one button, no confirmation.
 * Both are reversible and audited, so a dialog would only add a step. The
 * result is announced in a live region that stays mounted when the page
 * re-renders with the new status.
 */
export function AiSystemStatusForm({
  action,
  label,
  pendingLabel,
  explanation,
}: AiSystemStatusFormProps) {
  const [state, formAction, isPending] = useActionState(action, null);
  const explanationId = useId();

  const statusText = isPending
    ? pendingLabel
    : state
      ? `${isProblem(state.result) ? "Problem: " : ""}${AI_SYSTEM_STATUS_MESSAGES[state.result]}`
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
        {explanation}
      </p>
      <button
        type="submit"
        aria-disabled={isPending}
        aria-describedby={explanationId}
        className={SECONDARY_BUTTON}
      >
        {isPending ? pendingLabel : label}
      </button>
      <p
        role="status"
        aria-live="polite"
        className={
          statusText
            ? `rounded-md border px-3 py-2 text-sm ${
                state && isProblem(state.result) && !isPending
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
