"use client";

import { useActionState, useId, useState, type FormEvent } from "react";

import { magicLinkMessage } from "@/app/(auth)/sign-in/sign-in-messages";
import { TurnstileWidget } from "@/components/forms/turnstile-widget";
import {
  requestMagicLinkAction,
  type MagicLinkFormState,
} from "@/lib/auth/sign-in/actions";

type MagicLinkFormProps = {
  /** A message for a failed callback, already mapped from an allowlisted code. */
  callbackError?: string;
  /** Cloudflare Turnstile's public site key, for the challenge. */
  turnstileSiteKey: string;
};

export function MagicLinkForm({
  callbackError,
  turnstileSiteKey,
}: MagicLinkFormProps) {
  const [state, formAction, isPending] = useActionState<
    MagicLinkFormState,
    FormData
  >(requestMagicLinkAction, null);

  // Controlled, because React resets an uncontrolled form after its action
  // runs: a person correcting a typo would otherwise have to retype it all.
  const [email, setEmail] = useState("");

  // Counts attempts, so each answer that asks for a challenge mounts a fresh
  // widget: a Turnstile token works once.
  const [attempt, setAttempt] = useState(0);
  const challengeRequired =
    state?.result === "captcha_required" || state?.result === "captcha_failed";

  const emailId = useId();
  const statusId = useId();

  const result = state ? magicLinkMessage(state.result) : undefined;
  const statusText = isPending
    ? "Sending sign-in link…"
    : result
      ? `${result.tone === "problem" ? "Problem: " : "Sent: "}${result.text}`
      : "";

  function preventRepeatSubmit(event: FormEvent<HTMLFormElement>) {
    // A second submission while one is in flight would ask for a second link.
    // Refused here rather than by disabling the button, which would throw a
    // keyboard user's focus back to the top of the page.
    if (isPending) {
      event.preventDefault();
      return;
    }
    setAttempt((count) => count + 1);
  }

  return (
    <form
      action={formAction}
      onSubmit={preventRepeatSubmit}
      aria-busy={isPending}
      className="mt-6 space-y-4"
      noValidate
    >
      {/* The callback's error belongs to the previous attempt, so it goes as
          soon as a new one starts. */}
      {callbackError && !isPending && !state ? (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
        >
          Problem: {callbackError}
        </p>
      ) : null}

      <div className="space-y-2">
        <label htmlFor={emailId} className="block text-sm font-medium">
          Email address
        </label>

        <input
          id={emailId}
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          // Only an address the server rejected is marked invalid; an outage
          // says nothing about what was typed.
          aria-invalid={state?.result === "invalid_email"}
          aria-describedby={statusText ? statusId : undefined}
          className="w-full rounded-md border border-slate-500 px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
        />
      </div>

      {/* Only past the global sign-in threshold, so Cloudflare's script is not
          loaded on an ordinary visit. Before the button, so tabbing reaches
          the challenge first. */}
      {challengeRequired ? (
        <TurnstileWidget key={attempt} siteKey={turnstileSiteKey} />
      ) : null}

      <button
        type="submit"
        aria-disabled={isPending}
        className="w-full rounded-md bg-slate-900 px-4 py-2 font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 aria-disabled:cursor-not-allowed"
      >
        {isPending ? "Sending sign-in link…" : "Email me a sign-in link"}
      </button>

      {/* One live region for progress and result, so every change of state
          produces a new announcement; problems are marked in words, not only
          by colour. */}
      <p
        id={statusId}
        role="status"
        aria-live="polite"
        className={
          statusText
            ? `rounded-md border px-3 py-2 text-sm ${
                result?.tone === "problem" && !isPending
                  ? "border-red-300 bg-red-50 text-red-900"
                  : "border-slate-300 bg-slate-50 text-slate-900"
              }`
            : "sr-only"
        }
      >
        {statusText}
      </p>
    </form>
  );
}
