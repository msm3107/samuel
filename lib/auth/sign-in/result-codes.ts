/**
 * Outcomes the sign-in screen renders. Codes, not copy: the screen owns the
 * wording, and nothing here carries Supabase error text to the browser.
 */
export type MagicLinkResult = "link_sent" | "invalid_email" | "unavailable";

export type GoogleSignInResult =
  { status: "redirect"; url: string } | { status: "unavailable" };

/**
 * The only values `/sign-in?error=` may carry. The callback never echoes
 * anything it received; the screen maps these through a fixed table.
 */
export const CALLBACK_ERROR_CODES = [
  "link_invalid",
  "link_expired",
  "link_other_browser",
  "sign_in_failed",
  "sign_in_unavailable",
] as const;

export type CallbackErrorCode = (typeof CALLBACK_ERROR_CODES)[number];

export function isCallbackErrorCode(
  value: unknown,
): value is CallbackErrorCode {
  return (
    typeof value === "string" &&
    (CALLBACK_ERROR_CODES as readonly string[]).includes(value)
  );
}

export type CompleteSignInResult =
  { status: "signed-in" } | { status: "failed"; code: CallbackErrorCode };
