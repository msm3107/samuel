/**
 * Character rules for short user-supplied text that other people will read:
 * organization names, AI system names, providers.
 *
 * The database refuses the same characters with CHECK constraints (see
 * `supabase/migrations/20260921170000_name_format_characters.sql`), so text
 * these accept is never refused there. A unit test compares the two
 * definitions of "format character".
 */

/** Tab, line feed and carriage return: what multi-line text may keep. */
const LINE_BREAKS_AND_TABS: ReadonlySet<number> = new Set([0x09, 0x0a, 0x0d]);

/**
 * C0 controls and DEL, which Postgres's `[[:cntrl:]]` matches, plus C1.
 * `allowLineBreaks` keeps tabs, line feeds and carriage returns, for text
 * that may span lines, such as a description.
 */
export function hasControlCharacter(
  value: string,
  { allowLineBreaks = false }: { allowLineBreaks?: boolean } = {},
): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (allowLineBreaks && LINE_BREAKS_AND_TABS.has(code)) {
      continue;
    }
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/**
 * Unicode format characters (general category Cf): right-to-left overrides,
 * zero-width spaces, invisible tags. They let text display as something it
 * is not. The zero-width joiner (U+200D) is allowed, because emoji and some
 * scripts need it.
 */
const FORMAT_CHARACTER = /(?!\u200d)\p{Cf}/u;

export function hasFormatCharacter(value: string): boolean {
  return FORMAT_CHARACTER.test(value);
}
