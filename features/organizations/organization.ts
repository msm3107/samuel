import { z } from "zod";

import { hasControlCharacter, hasFormatCharacter } from "@/lib/validation/text";

/**
 * An organization's name as a person typed it: surrounding spaces trimmed,
 * 1 to 120 characters, no control or format characters. The same rules as
 * `public.create_organization` and the table's CHECK, so a name this accepts
 * is never refused by the database. Branded, so only a validated name reaches
 * the functions that write one.
 */
export const organizationNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((name) => !hasControlCharacter(name) && !hasFormatCharacter(name))
  .brand<"OrganizationName">();

export type OrganizationName = z.infer<typeof organizationNameSchema>;

/**
 * What any client is ever sent about an organization: its ID, name and slug.
 * Timestamps and `deleted_at` are internal (README §66). Built field by
 * field from a validated row, so a column added to the table or the query is
 * never passed through by accident.
 */
export type SerializedOrganization = Readonly<{
  id: string;
  name: string;
  slug: string;
}>;

const organizationRowSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
});

export function serializeOrganization(row: unknown): SerializedOrganization {
  const { id, name, slug } = organizationRowSchema.parse(row);
  return Object.freeze({ id, name, slug });
}

/** The columns every query selects: exactly what the serializer sends. */
export const ORGANIZATION_COLUMNS = "id, name, slug";
