"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { SIGN_IN_PATH } from "@/lib/auth/protected-routes";
import { checkMagicLinkGate } from "@/lib/auth/sign-in/magic-link-gate";
import { requestMagicLink } from "@/lib/auth/sign-in/request-magic-link";
import { withResponseFloor } from "@/lib/auth/sign-in/response-floor";
import type { MagicLinkResult } from "@/lib/auth/sign-in/result-codes";
import { signOut } from "@/lib/auth/sign-in/sign-out";
import { startGoogleSignIn } from "@/lib/auth/sign-in/start-google-sign-in";
import { signInErrorUrl } from "@/lib/auth/sign-in/urls";
import { requestNetwork } from "@/lib/security/client-ip";
import { TURNSTILE_RESPONSE_FIELD } from "@/lib/security/turnstile";

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
  const fields = formData instanceof FormData ? formData : undefined;

  // Format, per-network limit and global threshold: none depends on the
  // address, so these answer at once. See magic-link-gate.ts.
  const gate = await checkMagicLinkGate({
    email: fields?.get("email"),
    captchaToken: fields?.get(TURNSTILE_RESPONSE_FIELD),
    network: requestNetwork(await headers()),
  });
  if (gate.status === "refused") {
    return { result: gate.result };
  }

  // Every answer from here takes the same time, so the response cannot reveal
  // whether the address already has an account. See response-floor.ts.
  return {
    result: await withResponseFloor(() => requestMagicLink(gate.email)),
  };
}

export async function startGoogleSignInAction(): Promise<void> {
  const result = await startGoogleSignIn(requestNetwork(await headers()));
  if (result.status === "redirect") {
    redirect(result.url);
  }
  redirect(
    signInErrorUrl(
      result.status === "rate_limited" ? "rate_limited" : "sign_in_unavailable",
    ).toString(),
  );
}

export async function signOutAction(): Promise<void> {
  await signOut();
  redirect(SIGN_IN_PATH);
}
