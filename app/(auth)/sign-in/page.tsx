import type { Metadata } from "next";

import { callbackErrorMessage } from "@/app/(auth)/sign-in/sign-in-messages";
import { GoogleSignInForm } from "@/components/forms/google-sign-in-form";
import { MagicLinkForm } from "@/components/forms/magic-link-form";

export const metadata: Metadata = {
  title: "Sign in · Article50.js",
};

/**
 * The sign-in screen. It defines no security boundary: it calls the sign-in
 * functions and renders the code they return.
 *
 * `error` arrives from the callback and is mapped through a fixed table. An
 * unknown, hostile, or repeated value shows the generic message and is never
 * rendered.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { error } = await searchParams;
  // A repeated parameter is not one of the codes the callback sends, so it is
  // treated like any other unknown value rather than silently dropped.
  const callbackError = callbackErrorMessage(Array.isArray(error) ? "" : error);

  return (
    <main className="mx-auto max-w-md px-6 py-24">
      <h1 className="text-3xl font-semibold tracking-tight">Sign in</h1>

      <p className="mt-4 text-slate-700">
        Article50.js sends you a link to sign in. There is no password to
        remember.
      </p>

      <MagicLinkForm
        {...(callbackError === undefined ? {} : { callbackError })}
      />

      <div className="mt-8 border-t border-slate-200 pt-6">
        <p className="text-sm text-slate-600">Or use a Google account:</p>
        <GoogleSignInForm />
      </div>

      <p className="mt-10 text-sm text-slate-600">
        Open the sign-in link in the same browser you requested it from.
      </p>
    </main>
  );
}
