import {
  createAiSystemSchema,
  SYSTEM_TYPES,
  type CreateAiSystemInput,
  type SerializedAiSystem,
  type UpdateAiSystemInput,
} from "./ai-system";

/**
 * The dashboard's AI system form (TASK-010): what it reads from a submitted
 * form, and the labels it shows. The rules are TASK-009's schemas; this only
 * turns form fields into their input.
 */

/** How each system type is named on screen. */
export const SYSTEM_TYPE_LABELS = {
  chatbot: "Chatbot",
  voice_agent: "Voice agent",
  assistant: "Assistant",
  generator: "Content generator",
  other: "Other",
} as const satisfies Record<(typeof SYSTEM_TYPES)[number], string>;

export const AI_SYSTEM_FORM_FIELDS = [
  "name",
  "systemType",
  "provider",
  "description",
] as const;

export type AiSystemFormField = (typeof AI_SYSTEM_FORM_FIELDS)[number];

/** What the form's inputs hold, as text. */
export type AiSystemFormValues = Readonly<Record<AiSystemFormField, string>>;

/**
 * Longer than any field may be (a description's 2,000), so a value too long
 * to save still comes back as typed, but a forged megabyte does not come back
 * at all.
 */
const ECHO_LIMIT = 4000;

export type ParsedAiSystemForm =
  | { success: true; data: CreateAiSystemInput; values: AiSystemFormValues }
  | {
      success: false;
      fields: AiSystemFormField[];
      values: AiSystemFormValues;
    };

/**
 * Reads the four named fields and nothing else: an organization, status or
 * ID a forged request adds is never looked at. A blank provider or
 * description is none (`null`), so clearing the input clears the value.
 *
 * `values` is what was submitted, to put back in the form when it is
 * refused. It is only ever rendered as input values, which React escapes.
 */
export function parseAiSystemForm(formData: unknown): ParsedAiSystemForm {
  const values = submittedValues(formData);
  const parsed = createAiSystemSchema.safeParse({
    name: values.name,
    systemType: values.systemType,
    provider: blankToNull(values.provider),
    description: blankToNull(unixLineBreaks(values.description)),
  });
  if (!parsed.success) {
    return {
      success: false,
      fields: invalidFields(parsed.error.issues),
      values,
    };
  }
  return { success: true, data: parsed.data, values };
}

/**
 * The same form as an edit: all four fields are sent, so the change names
 * them all. The database writes an audit event only for fields whose value
 * really changed (TASK-008).
 */
export function parseAiSystemEditForm(formData: unknown) {
  const parsed = parseAiSystemForm(formData);
  if (!parsed.success) {
    return parsed;
  }
  const { name, systemType, provider, description } = parsed.data;
  const data: UpdateAiSystemInput = {
    name,
    systemType,
    provider: provider ?? null,
    description: description ?? null,
  };
  return { ...parsed, data };
}

/** A stored system, as the form shows it. */
export function formValuesOf(aiSystem: SerializedAiSystem): AiSystemFormValues {
  return {
    name: aiSystem.name,
    systemType: aiSystem.systemType,
    provider: aiSystem.provider ?? "",
    description: aiSystem.description ?? "",
  };
}

/**
 * A value longer than the echo limit is cut before parsing, but it was over
 * every field's maximum already, so it is refused either way.
 */
function submittedValues(formData: unknown): AiSystemFormValues {
  const field = (name: AiSystemFormField) => {
    const value = formData instanceof FormData ? formData.get(name) : undefined;
    return typeof value === "string" ? value.slice(0, ECHO_LIMIT) : "";
  };
  return {
    name: field("name"),
    systemType: field("systemType"),
    provider: field("provider"),
    description: field("description"),
  };
}

/**
 * Browsers submit a textarea's line breaks as CR LF (HTML's form encoding),
 * whatever was typed. Stored as LF, so a description has one kind of line
 * break, and its length is what the textarea counted.
 */
function unixLineBreaks(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function blankToNull(value: string): string | null {
  return value.trim() === "" ? null : value;
}

function invalidFields(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>,
): AiSystemFormField[] {
  const fields = new Set<AiSystemFormField>();
  for (const issue of issues) {
    const field = AI_SYSTEM_FORM_FIELDS.find((name) => name === issue.path[0]);
    if (field !== undefined) {
      fields.add(field);
    }
  }
  return AI_SYSTEM_FORM_FIELDS.filter((field) => fields.has(field));
}
