import { z } from "zod";

/**
 * An organization's name as a person typed it: surrounding spaces trimmed,
 * 1 to 120 characters, no control characters. The same rules as
 * `public.create_organization` and the table's CHECK, so a name this accepts
 * is never refused by the database. Branded, so only a validated name reaches
 * the functions that write one.
 */
export const organizationNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((name) => !hasControlCharacter(name))
  .brand<"OrganizationName">();

export type OrganizationName = z.infer<typeof organizationNameSchema>;

/**
 * The database's `[[:cntrl:]]`, C0 controls and DEL, plus the C1 controls,
 * which no one types in a name.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

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
