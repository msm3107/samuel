"use server";

import { redirect } from "next/navigation";

import { SIGN_IN_PATH } from "@/lib/auth/protected-routes";
import { requestMagicLink } from "@/lib/auth/sign-in/request-magic-link";
import { withResponseFloor } from "@/lib/auth/sign-in/response-floor";
import type { MagicLinkResult } from "@/lib/auth/sign-in/result-codes";
import { signOut } from "@/lib/auth/sign-in/sign-out";
import { startGoogleSignIn } from "@/lib/auth/sign-in/start-google-sign-in";

/**
 * Server actions for the sign-in screen. Next.js rejects a server action whose
 * Origin does not match the host, which is the CSRF protection sign-out relies
 * on. Each action is a thin adapter; the decisions live in the functions it
 * calls, where they are tested directly.
 */

export type MagicLinkFormState = { result: MagicLinkResult } | null;

export async function requestMagicLinkAction(
  _previous: MagicLinkFormState,
  formData: FormData,
): Promise<MagicLinkFormState> {
  // A server action's arguments arrive from the browser, so the FormData is
  // checked rather than assumed; a caller passing anything else gets the same
  // answer as an empty field.
  const email =
    formData instanceof FormData ? formData.get("email") : undefined;

  // Every answer takes the same time, so the response cannot reveal whether
  // the address already has an account. See response-floor.ts.
  return { result: await withResponseFloor(() => requestMagicLink(email)) };
}

export async function startGoogleSignInAction(): Promise<void> {
  const result = await startGoogleSignIn();
  if (result.status === "redirect") {
    redirect(result.url);
  }
  redirect(`${SIGN_IN_PATH}?error=sign_in_unavailable`);
}

export async function signOutAction(): Promise<void> {
  await signOut();
  redirect(SIGN_IN_PATH);
}
