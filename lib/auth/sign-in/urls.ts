import { SIGN_IN_PATH } from "@/lib/auth/protected-routes";
import type { CallbackErrorCode } from "@/lib/auth/sign-in/result-codes";
import { serverEnv } from "@/lib/env/server-env";

export const CALLBACK_PATH = "/auth/callback";
export const SIGNED_IN_PATH = "/dashboard";

/**
 * Every URL here is built from configuration. Deriving one from the request's
 * Host header would let a spoofed header point a magic link or a post-sign-in
 * redirect at another origin.
 */
function appUrl(path: string) {
  return new URL(path, serverEnv().NEXT_PUBLIC_APP_URL);
}

export function callbackUrl() {
  return appUrl(CALLBACK_PATH).toString();
}

export function signedInUrl() {
  return appUrl(SIGNED_IN_PATH);
}

export function signInErrorUrl(code: CallbackErrorCode) {
  const url = appUrl(SIGN_IN_PATH);
  url.searchParams.set("error", code);
  return url;
}
