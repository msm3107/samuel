import { z } from "zod";

import { DISCLOSURE_MESSAGE_MAX_LENGTH } from "./disclosure-fields";
import { DISCLOSURE_LANGUAGES } from "./languages";

/**
 * The public endpoint's response shape (TASK-019a). Three fields, decided
 * with TASK-019: no identifier, organization, system, hostname, timestamp
 * or author. README §11 documents the same three.
 */

/** Postgres's `integer`: a version can't be larger. */
const MAX_VERSION = 2_147_483_647;

/**
 * One row of `public.public_disclosure`, validated before anything is sent.
 * The database is external input like any other: strict, so a column added
 * to the function's return type reaches nobody until this schema says so,
 * which is what makes "no key beyond the documented three" true of the wire
 * and not only of the SQL.
 *
 * `language` is checked against the application's list rather than taken as
 * text. The `disclosures_language_check` constraint holds the same codes
 * and a unit test keeps the two in step, so a stored language this refuses
 * cannot be published in the first place.
 */
export const publicDisclosureSchema = z.strictObject({
  version: z.int().min(1).max(MAX_VERSION),
  language: z.enum(DISCLOSURE_LANGUAGES),
  // Bounded rather than merely non-empty: the table's own check allows no
  // more, so a longer value means something other than a stored message.
  message: z.string().min(1).max(DISCLOSURE_MESSAGE_MAX_LENGTH),
});

export type PublicDisclosure = Readonly<z.infer<typeof publicDisclosureSchema>>;

/**
 * What the function answers: zero rows or one. At most one is true by
 * construction — a deployment's identifier is unique and only its system's
 * current version can match — so a second row means the function changed
 * under the application, and refusing is better than picking one.
 */
export const publicDisclosureRowsSchema = z
  .array(publicDisclosureSchema)
  .max(1);
