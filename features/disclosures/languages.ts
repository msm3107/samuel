/**
 * The languages a disclosure can be written in (TASK-016): the ISO 639-1
 * codes of the 24 official EU languages, decided by Mikołaj Smoliniec
 * (project owner), 2026-09-22. The `disclosures_language_check` constraint
 * in supabase/migrations/ lists the same codes, and
 * tests/unit/disclosures/languages.test.ts keeps the two in step.
 */
export const DISCLOSURE_LANGUAGES = [
  "bg",
  "cs",
  "da",
  "de",
  "el",
  "en",
  "es",
  "et",
  "fi",
  "fr",
  "ga",
  "hr",
  "hu",
  "it",
  "lt",
  "lv",
  "mt",
  "nl",
  "pl",
  "pt",
  "ro",
  "sk",
  "sl",
  "sv",
] as const;

export type DisclosureLanguage = (typeof DISCLOSURE_LANGUAGES)[number];
