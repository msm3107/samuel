import { z } from "zod";

/** RFC 5321 caps a forward path at 254 octets. */
const MAX_EMAIL_LENGTH = 254;

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(MAX_EMAIL_LENGTH)
  .pipe(z.email());

/**
 * Normalizes an address from an untrusted form field. Returns null rather than
 * throwing: an invalid address is an expected outcome, not an error.
 */
export function parseEmail(input: unknown): string | null {
  const result = emailSchema.safeParse(input);
  return result.success ? result.data : null;
}
