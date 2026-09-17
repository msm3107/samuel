import {
  isCallbackErrorCode,
  type CallbackErrorCode,
  type MagicLinkResult,
} from "@/lib/auth/sign-in/result-codes";

/**
 * The screen's entire vocabulary. Every message is chosen here from a code,
 * never built from a query parameter or an auth-server message, so nothing a
 * visitor puts in the URL can reach the page.
 */
const CALLBACK_MESSAGES: Record<CallbackErrorCode, string> = {
  link_invalid: "That sign-in link is not valid. Request a new one below.",
  link_expired: "That sign-in link has expired. Request a new one below.",
  link_other_browser:
    "Open the link in the same browser you requested it from, or request a new one below.",
  sign_in_failed: "Sign-in did not complete. Try again below.",
  sign_in_unavailable:
    "Sign-in is unavailable right now. Please try again in a few minutes.",
};

const GENERIC_ERROR = "Sign-in did not complete. Try again below.";

/**
 * A recognised code gets its message; anything else gets the generic one. An
 * unknown value is never echoed back.
 */
export function callbackErrorMessage(error: string | undefined) {
  if (error === undefined) {
    return undefined;
  }
  return isCallbackErrorCode(error) ? CALLBACK_MESSAGES[error] : GENERIC_ERROR;
}

const MAGIC_LINK_MESSAGES: Record<
  MagicLinkResult,
  { tone: "confirmation" | "problem"; text: string }
> = {
  // Identical whether or not the address has an account, so the page never
  // reveals who is registered.
  link_sent: {
    tone: "confirmation",
    text: "Check your email. If that address can receive a sign-in link, one is on its way.",
  },
  invalid_email: {
    tone: "problem",
    text: "Enter an email address in the form name@example.com.",
  },
  unavailable: {
    tone: "problem",
    text: "Sign-in is unavailable right now. Please try again in a few minutes.",
  },
};

export function magicLinkMessage(result: MagicLinkResult) {
  return MAGIC_LINK_MESSAGES[result];
}
