"use client";

import {
  useActionState,
  useId,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";

import {
  AI_SYSTEM_FORM_MESSAGES,
  FIELD_MESSAGES,
  isProblem,
  type AiSystemFormState,
} from "@/app/(dashboard)/dashboard/[organizationId]/systems/messages";
import {
  SYSTEM_TYPE_LABELS,
  VERSION_FIELD,
  type AiSystemFormField,
  type AiSystemFormValues,
} from "@/features/ai-systems/ai-system-form";
import { PRIMARY_BUTTON, TEXT_INPUT } from "@/components/ui/styles";

type AiSystemFormProps = {
  /** A server action, already bound to its organization (and system). */
  action: (
    state: AiSystemFormState,
    formData: FormData,
  ) => Promise<AiSystemFormState>;
  /** What the inputs start with: blank, or the stored system. */
  initialValues: AiSystemFormValues;
  /** The stored system's version, for an edit form; none for a new one. */
  initialVersion?: string;
  submitLabel: string;
  pendingLabel: string;
};

/**
 * Registers or edits an AI system (TASK-010). Works without JavaScript: the
 * form posts to its server action, and the page renders the returned state.
 *
 * The inputs are controlled, because React resets an uncontrolled form after
 * its action. Each returned state carries values: what was typed, after a
 * refusal, or what was stored (trimmed and normalized), after a save.
 */
export function AiSystemForm({
  action,
  initialValues,
  initialVersion,
  submitLabel,
  pendingLabel,
}: AiSystemFormProps) {
  const [state, formAction, isPending] = useActionState(action, null);
  const [values, setValues] = useState(state?.values ?? initialValues);
  // The version an edit names: the one the form was loaded from, then the
  // one each save returns (TASK-010 review, finding 1).
  const [version, setVersion] = useState(state?.version ?? initialVersion);

  // A new result puts its values, and after a save its version, in the form.
  // Adjusted during render, as React recommends for state that follows
  // another, not in an effect.
  const [shownState, setShownState] = useState(state);
  if (state !== shownState) {
    setShownState(state);
    if (state !== null) {
      setValues(state.values);
      if (state.version !== undefined) {
        setVersion(state.version);
      }
    }
  }

  // The page re-rendered with a newer stored system, after an archive or a
  // restore for instance. An untouched form takes it on; a form with typed
  // changes keeps its older version, so saving them is refused as stale
  // rather than silently applied over whatever changed.
  const [loaded, setLoaded] = useState({
    values: initialValues,
    version: initialVersion,
  });
  if (initialVersion !== loaded.version) {
    setLoaded({ values: initialValues, version: initialVersion });
    if (sameValues(values, loaded.values)) {
      setValues(initialValues);
      setVersion(initialVersion);
    }
  }

  function change(field: AiSystemFormField) {
    return (
      event: ChangeEvent<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >,
    ) => setValues((current) => ({ ...current, [field]: event.target.value }));
  }

  const invalid = new Set<AiSystemFormField>(state?.fields ?? []);

  const baseId = useId();
  const idOf = (field: AiSystemFormField) => `${baseId}-${field}`;
  const errorIdOf = (field: AiSystemFormField) => `${baseId}-${field}-error`;
  const statusId = `${baseId}-status`;

  const statusText = isPending
    ? pendingLabel
    : state
      ? `${isProblem(state.result) ? "Problem: " : ""}${AI_SYSTEM_FORM_MESSAGES[state.result]}`
      : "";

  function describedBy(field: AiSystemFormField, hint?: string) {
    const ids = [hint, invalid.has(field) ? errorIdOf(field) : undefined];
    const joined = ids.filter((id) => id !== undefined).join(" ");
    return joined === "" ? undefined : joined;
  }

  function fieldError(field: AiSystemFormField) {
    return invalid.has(field) ? (
      <p id={errorIdOf(field)} className="text-sm text-red-800">
        Problem: {FIELD_MESSAGES[field]}
      </p>
    ) : null;
  }

  function preventRepeatSubmit(event: FormEvent<HTMLFormElement>) {
    // Refused here rather than by disabling the button, which would throw a
    // keyboard user's focus back to the top of the page.
    if (isPending) {
      event.preventDefault();
    }
  }

  const providerHint = `${baseId}-provider-hint`;

  return (
    <form
      action={formAction}
      onSubmit={preventRepeatSubmit}
      aria-busy={isPending}
      noValidate
      className="mt-6 space-y-5"
    >
      {version === undefined ? null : (
        <input type="hidden" name={VERSION_FIELD} value={version} />
      )}
      <div className="space-y-2">
        <label htmlFor={idOf("name")} className="block text-sm font-medium">
          Name
        </label>
        <input
          id={idOf("name")}
          name="name"
          required
          maxLength={120}
          autoComplete="off"
          value={values.name}
          onChange={change("name")}
          aria-invalid={invalid.has("name")}
          aria-describedby={describedBy("name")}
          className={TEXT_INPUT}
        />
        {fieldError("name")}
      </div>

      <div className="space-y-2">
        <label
          htmlFor={idOf("systemType")}
          className="block text-sm font-medium"
        >
          Type
        </label>
        <select
          id={idOf("systemType")}
          name="systemType"
          required
          value={values.systemType}
          onChange={change("systemType")}
          aria-invalid={invalid.has("systemType")}
          aria-describedby={describedBy("systemType")}
          className={TEXT_INPUT}
        >
          <option value="" disabled>
            Choose a type
          </option>
          {Object.entries(SYSTEM_TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        {fieldError("systemType")}
      </div>

      <div className="space-y-2">
        <label htmlFor={idOf("provider")} className="block text-sm font-medium">
          Provider <span className="font-normal">(optional)</span>
        </label>
        <p id={providerHint} className="text-sm text-slate-700">
          The company or model behind it, such as your own team or a vendor.
        </p>
        <input
          id={idOf("provider")}
          name="provider"
          maxLength={100}
          autoComplete="off"
          value={values.provider}
          onChange={change("provider")}
          aria-invalid={invalid.has("provider")}
          aria-describedby={describedBy("provider", providerHint)}
          className={TEXT_INPUT}
        />
        {fieldError("provider")}
      </div>

      <div className="space-y-2">
        <label
          htmlFor={idOf("description")}
          className="block text-sm font-medium"
        >
          Description <span className="font-normal">(optional)</span>
        </label>
        <textarea
          id={idOf("description")}
          name="description"
          rows={4}
          maxLength={2000}
          value={values.description}
          onChange={change("description")}
          aria-invalid={invalid.has("description")}
          aria-describedby={describedBy("description")}
          className={TEXT_INPUT}
        />
        {fieldError("description")}
      </div>

      <button
        type="submit"
        aria-disabled={isPending}
        className={PRIMARY_BUTTON}
      >
        {isPending ? pendingLabel : submitLabel}
      </button>

      {/* One live region for progress and result; problems are marked in
          words, not only by colour. */}
      <p
        id={statusId}
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

function sameValues(a: AiSystemFormValues, b: AiSystemFormValues): boolean {
  return (
    a.name === b.name &&
    a.systemType === b.systemType &&
    a.provider === b.provider &&
    a.description === b.description
  );
}
