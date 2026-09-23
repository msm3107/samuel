import {
  publishDisclosureSchema,
  type PublishDisclosureInput,
  type SerializedDisclosure,
} from "./disclosure";
import {
  DISCLOSURE_FORM_FIELDS,
  EMPTY_DISCLOSURE_FORM_VALUES,
  ENABLED_FIELD,
  LANGUAGE_FIELD,
  MESSAGE_FIELD,
  VERSION_FIELD,
  type DisclosureFormField,
  type DisclosureFormValues,
} from "./disclosure-fields";

/**
 * The dashboard's disclosure editor (TASK-018): what it reads from a
 * submitted form. The rules are TASK-017's schema, which the database holds
 * too (TASK-016); this only turns form fields into its input.
 */

/**
 * Four times the message's 500 characters, so a notice too long to publish
 * still comes back as typed, but a forged megabyte does not come back at
 * all. A value cut here was over the limit already, so it is refused either
 * way.
 */
const ECHO_LIMIT = 2000;

/**
 * The version the editor was loaded from:
 *
 * - `none`: the form sent no version field, which is what a system with no
 *   published version means. `expectedVersion` is then null.
 * - `version`: the number the editor was showing.
 * - `unreadable`: a field that is present but is not a version number. Only
 *   a forged or broken request does that, and the action refuses it rather
 *   than publishing over whatever is current.
 */
export type ExpectedVersion =
  | { kind: "none" }
  | { kind: "version"; value: number }
  | { kind: "unreadable" };

export type ParsedDisclosureForm = {
  expectedVersion: ExpectedVersion;
  values: DisclosureFormValues;
} & (
  | { success: true; data: PublishDisclosureInput }
  | { success: false; fields: DisclosureFormField[] }
);

/**
 * Reads the three named fields and the version, and nothing else: an
 * organization, system, ID, author or time a forged request adds is never
 * looked at.
 *
 * `values` is what was submitted, to put back in the editor when it is
 * refused. It is only ever rendered as a form control's value, which React
 * escapes.
 *
 * A trailing line break, which a textarea picks up easily, is trimmed away
 * by the schema like any other end whitespace. A line break inside the text
 * is refused: a disclosure is one line (TASK-016).
 */
export function parseDisclosureForm(formData: unknown): ParsedDisclosureForm {
  const values = submittedValues(formData);
  const expectedVersion = submittedVersion(formData);
  const parsed = publishDisclosureSchema.safeParse({
    message: values.message,
    language: values.language,
    enabled: values.enabled,
    expectedVersion:
      expectedVersion.kind === "version" ? expectedVersion.value : null,
  });
  if (!parsed.success) {
    return {
      success: false,
      fields: invalidFields(parsed.error.issues),
      expectedVersion,
      values,
    };
  }
  return { success: true, data: parsed.data, expectedVersion, values };
}

/** A published version, as the editor shows it. */
export function formValuesOf(
  disclosure: SerializedDisclosure,
): DisclosureFormValues {
  return {
    message: disclosure.message,
    language: disclosure.language,
    enabled: disclosure.enabled,
  };
}

function submittedValues(formData: unknown): DisclosureFormValues {
  if (!(formData instanceof FormData)) {
    return EMPTY_DISCLOSURE_FORM_VALUES;
  }
  const text = (name: string) => {
    const value = formData.get(name);
    return typeof value === "string" ? value.slice(0, ECHO_LIMIT) : "";
  };
  return {
    message: text(MESSAGE_FIELD),
    language: text(LANGUAGE_FIELD),
    // An unchecked checkbox sends nothing at all, which is what "off" is.
    enabled: formData.get(ENABLED_FIELD) !== null,
  };
}

function submittedVersion(formData: unknown): ExpectedVersion {
  const submitted =
    formData instanceof FormData ? formData.get(VERSION_FIELD) : null;
  if (submitted === null) {
    return { kind: "none" };
  }
  if (typeof submitted !== "string" || !/^[0-9]{1,10}$/.test(submitted)) {
    return { kind: "unreadable" };
  }
  const value = Number(submitted);
  return value >= 1 && value <= 2_147_483_647
    ? { kind: "version", value }
    : { kind: "unreadable" };
}

function invalidFields(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>,
): DisclosureFormField[] {
  const fields = new Set<DisclosureFormField>();
  for (const issue of issues) {
    const field = DISCLOSURE_FORM_FIELDS.find((name) => name === issue.path[0]);
    if (field !== undefined) {
      fields.add(field);
    }
  }
  return DISCLOSURE_FORM_FIELDS.filter((field) => fields.has(field));
}
