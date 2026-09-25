import { z } from "zod";

import {
  hasControlCharacter,
  hasFormatCharacter,
  hasLineOrParagraphSeparator,
} from "@/lib/validation/text";

import { DISCLOSURE_MESSAGE_MAX_LENGTH } from "./disclosure-fields";
import { DISCLOSURE_LANGUAGES, type DisclosureLanguage } from "./languages";

/**
 * Disclosure input rules and response shape (TASK-017). The database holds
 * the same rules (TASK-016's `disclosures_message_check` and language
 * list), so a message this accepts is never refused there.
 */

// The limit itself is in `disclosure-fields.ts`, which the editor may
// import; this module holds the rule that enforces it (PR #33 review,
// note 4). Re-exported so TASK-017's callers keep their import.
export { DISCLOSURE_MESSAGE_MAX_LENGTH };

/**
 * One line of plain text (TASK-016, PR #31 review).
 *
 * - Trimmed. JavaScript's trim removes every Unicode space (category Zs)
 *   and line terminator at the ends, a superset of what the table refuses
 *   there.
 * - NFC first, so the length and the checks see what is stored.
 * - No control or format characters (U+200D allowed), and no line or
 *   paragraph separator inside.
 */
export const disclosureMessageSchema = z
  .string()
  .trim()
  .normalize("NFC")
  .min(1)
  // Zod 4 counts a string's length in code points, as the table's
  // char_length does; the 500- and 501-emoji unit tests pin that.
  .max(DISCLOSURE_MESSAGE_MAX_LENGTH)
  .refine(
    (value) =>
      !hasControlCharacter(value) &&
      !hasFormatCharacter(value) &&
      !hasLineOrParagraphSeparator(value),
  );

/** Postgres's `integer`: a version can't be larger. */
const MAX_VERSION = 2_147_483_647;

/**
 * A new version. Strict: the organization and AI system come from the
 * route, and the ID, version, author and time are the database's, so a
 * body naming any of them is refused rather than trimmed.
 *
 * `expectedVersion` is the version the person was looking at, or null if
 * the system had none (owner's decision, 2026-09-22): a publish based on
 * an older version is refused rather than silently replacing a
 * colleague's newer text. `enabled` is required, so turning the notice off
 * is always said, never defaulted.
 */
export const publishDisclosureSchema = z.strictObject({
  message: disclosureMessageSchema,
  language: z.enum(DISCLOSURE_LANGUAGES),
  enabled: z.boolean(),
  expectedVersion: z.int().min(1).max(MAX_VERSION).nullable(),
});

export type PublishDisclosureInput = z.infer<typeof publishDisclosureSchema>;

/**
 * What a client is sent about a version. Built field by field from a
 * validated row, so a column added to the table is never passed through by
 * accident. `message` is plain text: whatever shows it must render it as
 * text, never as HTML (PLAN Phase 5).
 */
export type SerializedDisclosure = Readonly<{
  id: string;
  version: number;
  message: string;
  language: DisclosureLanguage;
  enabled: boolean;
  createdAt: string;
  createdBy: string;
}>;
