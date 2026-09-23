import type {
  DisclosureFormField,
  DisclosureFormValues,
} from "@/features/disclosures/disclosure-fields";
import { DISCLOSURE_MESSAGE_MAX_LENGTH } from "@/features/disclosures/disclosure";

/**
 * What the disclosure editor can report (TASK-018), each with fixed text.
 * The action returns only a code; the page shows the text from these tables,
 * so nothing the database or a forged request chooses is put on the page as
 * a message.
 */

export function disclosurePath(
  organizationId: string,
  systemId: string,
): string {
  return `/dashboard/${organizationId}/systems/${systemId}/disclosure`;
}

/** Why a field was refused, next to the field. */
export const FIELD_MESSAGES = {
  message: `Enter a notice of 1 to ${DISCLOSURE_MESSAGE_MAX_LENGTH} characters, on one line, without invisible characters.`,
  language: "Choose the language this notice is written in.",
} as const satisfies Record<DisclosureFormField, string>;

export const DISCLOSURE_FORM_MESSAGES = {
  published: "Published. This is the current version now.",
  invalid: "Some fields need changing. Each one says why.",
  disclosure_changed:
    "Someone published a newer version since you opened this page, so nothing was published. Reload the page to see it; what you typed stays in the form until you do.",
  disclosure_unchanged:
    "This is the same as the current version, so no new version was published.",
  ai_system_archived:
    "This system is archived, so its notice can't be changed. Restore the system first.",
  ai_system_not_found: "This system is no longer in this organization.",
  not_permitted:
    "You no longer have permission to publish this organization's disclosures.",
  stale:
    "This page is out of date, so nothing was published. Reload it and try again.",
} as const;

export type DisclosureFormResult = keyof typeof DISCLOSURE_FORM_MESSAGES;

/**
 * What the editor's action returns. `values` fills the form again: what was
 * typed after a refusal, what was published after a publish. `version` is
 * the version the next publish must name, sent after a publish.
 */
export type DisclosureFormState = Readonly<{
  result: DisclosureFormResult;
  fields: readonly DisclosureFormField[];
  values: DisclosureFormValues;
  version?: number;
}> | null;

/** Whether a result is a refusal, to mark it as a problem in words. */
export function isProblem(result: DisclosureFormResult): boolean {
  return result !== "published";
}
