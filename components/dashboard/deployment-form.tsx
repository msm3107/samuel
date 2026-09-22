"use client";

import {
  useActionState,
  useId,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";

import {
  DEPLOYMENT_FORM_MESSAGES,
  HOSTNAME_MESSAGES,
  type DeploymentFormState,
} from "@/app/(dashboard)/dashboard/[organizationId]/deployments/messages";
import { HOSTNAME_FIELD } from "@/features/deployments/deployment-fields";
import { PRIMARY_BUTTON, TEXT_INPUT } from "@/components/ui/styles";

type DeploymentFormProps = {
  /** A server action, already bound to its organization and AI system. */
  action: (
    state: DeploymentFormState,
    formData: FormData,
  ) => Promise<DeploymentFormState>;
};

/**
 * Registers a hostname under an AI system (TASK-015). Works without
 * JavaScript: the form posts to its server action, which opens the new
 * deployment, or returns a refusal and the hostname as typed.
 *
 * The input is controlled, because React resets an uncontrolled form after
 * its action, and a refusal should leave what was typed in place to fix.
 * Every state an action returns is a refusal, so each is marked as a
 * problem in words, not only by colour.
 */
export function DeploymentForm({ action }: DeploymentFormProps) {
  const [state, formAction, isPending] = useActionState(action, null);
  const [value, setValue] = useState(state?.value ?? "");

  // A new result puts its value in the input, adjusted during render as
  // React recommends for state that follows another.
  const [shownState, setShownState] = useState(state);
  if (state !== shownState) {
    setShownState(state);
    if (state !== null) {
      setValue(state.value);
    }
  }

  const baseId = useId();
  const inputId = `${baseId}-hostname`;
  const hintId = `${baseId}-hint`;
  const statusId = `${baseId}-status`;

  const refused = state !== null && !isPending;
  // Only a refusal of what was typed marks the input: a lost permission or
  // an archived system is not the hostname's fault.
  const hostnameRefused =
    refused && (state.result in HOSTNAME_MESSAGES || state.result === "exists");
  const statusText = isPending
    ? "Registering…"
    : state
      ? `Problem: ${DEPLOYMENT_FORM_MESSAGES[state.result]}`
      : "";

  function preventRepeatSubmit(event: FormEvent<HTMLFormElement>) {
    // Refused here rather than by disabling the button, which would throw a
    // keyboard user's focus back to the top of the page.
    if (isPending) {
      event.preventDefault();
    }
  }

  return (
    <form
      action={formAction}
      onSubmit={preventRepeatSubmit}
      aria-busy={isPending}
      noValidate
      className="mt-4 space-y-4"
    >
      <div className="space-y-2">
        <label htmlFor={inputId} className="block text-sm font-medium">
          Hostname
        </label>
        <p id={hintId} className="text-sm text-slate-700">
          Where the AI system appears, such as www.example.com. A site address
          such as https://www.example.com/ works too; a page, port or IP address
          doesn&apos;t.
        </p>
        <input
          id={inputId}
          name={HOSTNAME_FIELD}
          required
          maxLength={1024}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          inputMode="url"
          dir="ltr"
          value={value}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            setValue(event.target.value)
          }
          aria-invalid={hostnameRefused}
          aria-describedby={hostnameRefused ? `${hintId} ${statusId}` : hintId}
          className={TEXT_INPUT}
        />
      </div>

      <button
        type="submit"
        aria-disabled={isPending}
        className={PRIMARY_BUTTON}
      >
        {isPending ? "Registering…" : "Register hostname"}
      </button>

      <p
        id={statusId}
        role="status"
        aria-live="polite"
        className={
          statusText
            ? `rounded-md border px-3 py-2 text-sm ${
                refused
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
