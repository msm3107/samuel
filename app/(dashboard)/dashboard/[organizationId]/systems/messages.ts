import type {
  AiSystemFormField,
  AiSystemFormValues,
} from "@/features/ai-systems/ai-system-form";

/**
 * What the AI system forms can report (TASK-010), each with fixed text. An
 * action returns only a code; the page shows the text from these tables, so
 * nothing the server or a forged request chooses is put on the page as a
 * message.
 */

export function systemsPath(organizationId: string): string {
  return `/dashboard/${organizationId}/systems`;
}

export function systemPath(organizationId: string, systemId: string): string {
  return `${systemsPath(organizationId)}/${systemId}`;
}

/** Why a field was refused, next to the field. */
export const FIELD_MESSAGES = {
  name: "Enter a name of 1 to 120 characters, on one line, without invisible characters.",
  systemType: "Choose what kind of system this is.",
  provider:
    "Enter a provider of up to 100 characters, on one line, without invisible characters, or leave it empty.",
  description:
    "Enter a description of up to 2,000 characters, or leave it empty. Tabs and line breaks are fine; other control characters are not.",
} as const satisfies Record<AiSystemFormField, string>;

export const AI_SYSTEM_FORM_MESSAGES = {
  invalid: "Some fields need changing. Each one says why.",
  name_taken:
    "Another active system in this organization already has this name.",
  not_permitted:
    "You no longer have permission to change this organization's AI systems.",
  not_found: "This system is no longer in this organization.",
  saved: "Changes saved.",
} as const;

export type AiSystemFormResult = keyof typeof AI_SYSTEM_FORM_MESSAGES;

/**
 * What a create or edit action returns. `values` fills the form again: what
 * was typed after a refusal, what was stored after a save.
 */
export type AiSystemFormState = Readonly<{
  result: AiSystemFormResult;
  fields: readonly AiSystemFormField[];
  values: AiSystemFormValues;
}> | null;

export const AI_SYSTEM_STATUS_MESSAGES = {
  archived: "Archived. It no longer appears among the active systems.",
  restored: "Restored. It is active again.",
  name_taken:
    "It can't be restored while another active system has its name. Rename one of them first.",
  not_permitted:
    "You no longer have permission to change this organization's AI systems.",
  not_found: "This system is no longer in this organization.",
  invalid: "That change isn't possible.",
} as const;

export type AiSystemStatusResult = keyof typeof AI_SYSTEM_STATUS_MESSAGES;

export type AiSystemStatusState = Readonly<{
  result: AiSystemStatusResult;
}> | null;

/** Whether a result is a refusal, to mark it as a problem in words. */
export function isProblem(
  result: AiSystemFormResult | AiSystemStatusResult,
): boolean {
  return result !== "saved" && result !== "archived" && result !== "restored";
}
