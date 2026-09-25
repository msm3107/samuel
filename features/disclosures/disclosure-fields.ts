import { DISCLOSURE_LANGUAGES, type DisclosureLanguage } from "./languages";

/**
 * What the disclosure screen's client components may import (TASK-018):
 * field names and labels only. The form's parser is in `disclosure-form.ts`,
 * apart from these, so a client component never pulls the schemas in.
 */

/**
 * How long a notice may be, counted as the table counts it: code points,
 * not UTF-16 units. It lives here, beside the labels, rather than beside
 * the schema that enforces it (PR #33 review, note 4): the editor needs it,
 * and this module is the one the client may import. `disclosure.ts` takes it
 * from here, so there is still one number.
 */
export const DISCLOSURE_MESSAGE_MAX_LENGTH = 500;

/**
 * What the textarea's own `maxLength` allows. A code point is at most two
 * UTF-16 units, which is what HTML counts, so this can never cut a notice
 * the server would accept. Past 500 code points the server refuses it, and
 * the counter below the field says so first.
 */
export const DISCLOSURE_MESSAGE_INPUT_LIMIT = DISCLOSURE_MESSAGE_MAX_LENGTH * 2;

/** Characters as the server counts them: code points, not UTF-16 units. */
export function countCharacters(value: string): number {
  return [...value].length;
}

export const MESSAGE_FIELD = "message";
export const LANGUAGE_FIELD = "language";
export const ENABLED_FIELD = "enabled";

/** The hidden field carrying the version the editor was loaded from. */
export const VERSION_FIELD = "expectedVersion";

/** The fields a person can get wrong; `enabled` is a checkbox, so it can't. */
export const DISCLOSURE_FORM_FIELDS = [MESSAGE_FIELD, LANGUAGE_FIELD] as const;

export type DisclosureFormField = (typeof DISCLOSURE_FORM_FIELDS)[number];

/** What the editor's inputs hold. */
export type DisclosureFormValues = Readonly<{
  message: string;
  language: string;
  enabled: boolean;
}>;

/** A blank editor, and what a refused caller is given back. */
export const EMPTY_DISCLOSURE_FORM_VALUES: DisclosureFormValues = Object.freeze(
  { message: "", language: "", enabled: true },
);

/**
 * The 24 languages by their English name, because the dashboard is written
 * in English (TASK-018). The stored value stays the ISO 639-1 code; only
 * the label changes if this product is ever translated.
 */
export const DISCLOSURE_LANGUAGE_LABELS = {
  bg: "Bulgarian",
  cs: "Czech",
  da: "Danish",
  de: "German",
  el: "Greek",
  en: "English",
  es: "Spanish",
  et: "Estonian",
  fi: "Finnish",
  fr: "French",
  ga: "Irish",
  hr: "Croatian",
  hu: "Hungarian",
  it: "Italian",
  lt: "Lithuanian",
  lv: "Latvian",
  mt: "Maltese",
  nl: "Dutch",
  pl: "Polish",
  pt: "Portuguese",
  ro: "Romanian",
  sk: "Slovak",
  sl: "Slovenian",
  sv: "Swedish",
} as const satisfies Record<DisclosureLanguage, string>;

/**
 * The picker's options, in alphabetical order by the name shown. Sorted
 * from the list above rather than written out again, so a language can't
 * appear in one place and not the other.
 */
export const DISCLOSURE_LANGUAGE_OPTIONS: ReadonlyArray<
  Readonly<{ value: DisclosureLanguage; label: string }>
> = Object.freeze(
  [...DISCLOSURE_LANGUAGES]
    .map((value) => ({ value, label: DISCLOSURE_LANGUAGE_LABELS[value] }))
    .sort((a, b) => a.label.localeCompare(b.label, "en"))
    .map((option) => Object.freeze(option)),
);

/** A stored code as it is shown; an unknown one is shown as it is stored. */
export function languageLabel(language: string): string {
  return language in DISCLOSURE_LANGUAGE_LABELS
    ? DISCLOSURE_LANGUAGE_LABELS[language as DisclosureLanguage]
    : language;
}
