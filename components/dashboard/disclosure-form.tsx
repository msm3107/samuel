"use client";

import {
  useActionState,
  useId,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";

import {
  DISCLOSURE_FORM_MESSAGES,
  FIELD_MESSAGES,
  isProblem,
  type DisclosureFormState,
} from "@/app/(dashboard)/dashboard/[organizationId]/systems/[systemId]/disclosure/messages";
import { FOCUS_RING, PRIMARY_BUTTON, TEXT_INPUT } from "@/components/ui/styles";
import { DISCLOSURE_MESSAGE_MAX_LENGTH } from "@/features/disclosures/disclosure";
import {
  DISCLOSURE_LANGUAGE_OPTIONS,
  ENABLED_FIELD,
  LANGUAGE_FIELD,
  MESSAGE_FIELD,
  VERSION_FIELD,
  type DisclosureFormField,
  type DisclosureFormValues,
} from "@/features/disclosures/disclosure-fields";

type DisclosureFormProps = {
  /** A server action, already bound to its organization and AI system. */
  action: (
    state: DisclosureFormState,
    formData: FormData,
  ) => Promise<DisclosureFormState>;
  /** What the controls start with: the current version, or blank. */
  initialValues: DisclosureFormValues;
  /** The current version's number; none when nothing is published yet. */
  initialVersion?: number | undefined;
};

/**
 * Writes and publishes an AI system's disclosure (TASK-018). Works without
 * JavaScript: the form posts to its server action, and the page renders the
 * returned state.
 *
 * Every publish is a new, permanent version. The hidden version field says
 * which one it follows, so publishing over someone else's newer text is
 * refused rather than done silently (TASK-017).
 *
 * The controls are controlled, because React resets an uncontrolled form
 * after its action. Each returned state carries values: what was typed,
 * after a refusal, or what was published, after a publish.
 */
export function DisclosureForm({
  action,
  initialValues,
  initialVersion,
}: DisclosureFormProps) {
  const [state, formAction, isPending] = useActionState(action, null);
  const [values, setValues] = useState(state?.values ?? initialValues);
  const [version, setVersion] = useState(state?.version ?? initialVersion);

  // A new result puts its values, and after a publish its version, in the
  // form. Adjusted during render, as React recommends for state that
  // follows another, not in an effect.
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

  // The page re-rendered with a newer published version, someone else's for
  // instance. An untouched editor takes it on; an editor with typed changes
  // keeps its older version, so publishing them is refused as changed
  // rather than silently applied over what arrived.
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

  function changeText(field: "message" | "language") {
    return (event: ChangeEvent<HTMLTextAreaElement | HTMLSelectElement>) =>
      setValues((current) => ({ ...current, [field]: event.target.value }));
  }

  const invalid = new Set<DisclosureFormField>(state?.fields ?? []);

  const baseId = useId();
  const idOf = (field: DisclosureFormField) => `${baseId}-${field}`;
  const errorIdOf = (field: DisclosureFormField) => `${baseId}-${field}-error`;
  const enabledId = `${baseId}-enabled`;
  const messageHint = `${baseId}-message-hint`;
  const enabledHint = `${baseId}-enabled-hint`;

  const statusText = isPending
    ? "Publishing…"
    : state
      ? `${isProblem(state.result) ? "Problem: " : ""}${DISCLOSURE_FORM_MESSAGES[state.result]}`
      : "";

  function describedBy(field: DisclosureFormField, hint?: string) {
    const ids = [hint, invalid.has(field) ? errorIdOf(field) : undefined];
    const joined = ids.filter((id) => id !== undefined).join(" ");
    return joined === "" ? undefined : joined;
  }

  function fieldError(field: DisclosureFormField) {
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
        <label htmlFor={idOf("message")} className="block text-sm font-medium">
          Notice
        </label>
        <p id={messageHint} className="text-sm text-slate-700">
          What visitors read where your system is used, on one line, up to{" "}
          {DISCLOSURE_MESSAGE_MAX_LENGTH} characters. It is shown as plain text.
        </p>
        <textarea
          id={idOf("message")}
          name={MESSAGE_FIELD}
          required
          rows={3}
          maxLength={DISCLOSURE_MESSAGE_MAX_LENGTH}
          dir="auto"
          value={values.message}
          onChange={changeText("message")}
          aria-invalid={invalid.has("message")}
          aria-describedby={describedBy("message", messageHint)}
          className={TEXT_INPUT}
        />
        {fieldError("message")}
      </div>

      <div className="space-y-2">
        <label htmlFor={idOf("language")} className="block text-sm font-medium">
          Language
        </label>
        <select
          id={idOf("language")}
          name={LANGUAGE_FIELD}
          required
          value={values.language}
          onChange={changeText("language")}
          aria-invalid={invalid.has("language")}
          aria-describedby={describedBy("language")}
          className={TEXT_INPUT}
        >
          <option value="" disabled>
            Choose a language
          </option>
          {DISCLOSURE_LANGUAGE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {fieldError("language")}
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <input
            id={enabledId}
            name={ENABLED_FIELD}
            type="checkbox"
            checked={values.enabled}
            onChange={(event) =>
              setValues((current) => ({
                ...current,
                enabled: event.target.checked,
              }))
            }
            aria-describedby={enabledHint}
            className={`size-4 ${FOCUS_RING}`}
          />
          <label htmlFor={enabledId} className="text-sm font-medium">
            Show this notice on the website
          </label>
        </div>
        <p id={enabledHint} className="text-sm text-slate-700">
          Turning it off publishes a new version that the widget does not show.
          Nothing is deleted: every version stays in the history below.
        </p>
      </div>

      <button
        type="submit"
        aria-disabled={isPending}
        className={PRIMARY_BUTTON}
      >
        {isPending ? "Publishing…" : "Publish"}
      </button>

      {/* One live region for progress and result; problems are marked in
          words, not only by colour. */}
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

function sameValues(a: DisclosureFormValues, b: DisclosureFormValues): boolean {
  return (
    a.message === b.message &&
    a.language === b.language &&
    a.enabled === b.enabled
  );
}
