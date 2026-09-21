import { z } from "zod";

import { hasControlCharacter, hasFormatCharacter } from "@/lib/validation/text";

/**
 * AI system input rules and the one shape a client is sent (TASK-009).
 *
 * Every rule mirrors a CHECK on `public.ai_systems` (TASK-008), so a request
 * these accept is never refused by the database as invalid. A unit test
 * compares the two.
 */

export const SYSTEM_TYPES = [
  "chatbot",
  "voice_agent",
  "assistant",
  "generator",
  "other",
] as const;

export const SYSTEM_STATUSES = ["active", "archived"] as const;

/**
 * One line of text other people will read: trimmed, in Unicode's composed
 * form (NFC), no hidden characters. NFC first, so "Café" typed as `e` plus a
 * combining accent is stored as the same four characters as the precomposed
 * one, and the two cannot pass as different names (PR #23 review, finding 2).
 * The length is counted after normalizing, as the table counts it.
 */
function singleLine(max: number) {
  return z
    .string()
    .trim()
    .normalize("NFC")
    .min(1)
    .max(max)
    .refine(
      (value) => !hasControlCharacter(value) && !hasFormatCharacter(value),
    );
}

/**
 * Several lines allowed, as in the table: tabs, line feeds and carriage
 * returns are the only control characters kept. Format characters are not
 * refused here, as the table does not: a description is prose, and some
 * scripts need them. The table refuses the same controls.
 */
const description = z
  .string()
  .trim()
  .normalize("NFC")
  .min(1)
  .max(2000)
  .refine((value) => !hasControlCharacter(value, { allowLineBreaks: true }));

export const aiSystemNameSchema = singleLine(120);
export const aiSystemProviderSchema = singleLine(100);
export const aiSystemDescriptionSchema = description;

/**
 * A new system. Strict: the organization comes from the route, the status
 * starts `active`, and the ID and timestamps are the database's, so a body
 * naming any of them is refused rather than silently trimmed.
 */
export const createAiSystemSchema = z.strictObject({
  name: aiSystemNameSchema,
  systemType: z.enum(SYSTEM_TYPES),
  description: aiSystemDescriptionSchema.nullable().optional(),
  provider: aiSystemProviderSchema.nullable().optional(),
});

export type CreateAiSystemInput = z.infer<typeof createAiSystemSchema>;

/**
 * A change. Any subset of the editable fields, at least one. `null` clears
 * the description or provider; `status` archives or un-archives.
 */
export const updateAiSystemSchema = z
  .strictObject({
    name: aiSystemNameSchema.optional(),
    systemType: z.enum(SYSTEM_TYPES).optional(),
    description: aiSystemDescriptionSchema.nullable().optional(),
    provider: aiSystemProviderSchema.nullable().optional(),
    status: z.enum(SYSTEM_STATUSES).optional(),
  })
  .refine((change) => Object.keys(change).length > 0);

export type UpdateAiSystemInput = z.infer<typeof updateAiSystemSchema>;

/** `?status=` on the list: active by default. */
export const aiSystemListFilterSchema = z
  .enum([...SYSTEM_STATUSES, "all"])
  .default("active");

export type AiSystemListFilter = z.infer<typeof aiSystemListFilterSchema>;

/**
 * What a client is sent about a system (README §66). Built field by field
 * from a validated row, so a column added to the table is never passed
 * through by accident. The organization is not repeated: the client asked
 * under it.
 */
export type SerializedAiSystem = Readonly<{
  id: string;
  name: string;
  description: string | null;
  systemType: (typeof SYSTEM_TYPES)[number];
  provider: string | null;
  status: (typeof SYSTEM_STATUSES)[number];
}>;

const aiSystemRowSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  system_type: z.enum(SYSTEM_TYPES),
  provider: z.string().nullable(),
  status: z.enum(SYSTEM_STATUSES),
});

export function serializeAiSystem(row: unknown): SerializedAiSystem {
  const parsed = aiSystemRowSchema.parse(row);
  return Object.freeze({
    id: parsed.id,
    name: parsed.name,
    description: parsed.description,
    systemType: parsed.system_type,
    provider: parsed.provider,
    status: parsed.status,
  });
}

/** The columns every query selects: exactly what the serializer reads. */
export const AI_SYSTEM_COLUMNS =
  "id, name, description, system_type, provider, status";
