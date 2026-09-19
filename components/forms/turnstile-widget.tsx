"use client";

import { useEffect, useId, useRef, useState } from "react";

/**
 * Cloudflare's script, loaded explicitly so the widget renders only where and
 * when this component asks. It is inserted by this application's own
 * nonce-trusted code, which the policy's 'strict-dynamic' trusts in turn.
 */
const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** Kept in step with MAGIC_LINK_ACTION in lib/security/turnstile.ts. */
const MAGIC_LINK_ACTION = "magic_link";

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      theme: "auto";
      "refresh-expired": "auto";
      callback: () => void;
      "error-callback": () => boolean;
    },
  ) => string;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi> | undefined;

function loadTurnstile(): Promise<TurnstileApi> {
  scriptPromise ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.onload = () =>
      window.turnstile
        ? resolve(window.turnstile)
        : reject(new Error("Turnstile did not initialise"));
    script.onerror = () => reject(new Error("Turnstile did not load"));
    document.head.append(script);
  }).catch((error: unknown) => {
    // A later attempt may succeed; do not cache the failure.
    scriptPromise = undefined;
    throw error;
  });
  return scriptPromise;
}

/**
 * The challenge the magic-link form shows past the global threshold. It
 * renders inside the form, and Cloudflare adds the token to it as the
 * `cf-turnstile-response` field. Each token is single-use, so the form
 * remounts this component (by `key`) after every attempt.
 */
export function TurnstileWidget({ siteKey }: { siteKey: string }) {
  const container = useRef<HTMLDivElement>(null);
  // "unavailable": the script never loaded, so there is nothing to solve.
  // "retrying": the challenge failed once; Turnstile retries on its own and
  // clears this through `callback` when it succeeds.
  const [problem, setProblem] = useState<"unavailable" | "retrying" | null>(
    null,
  );
  const descriptionId = useId();

  useEffect(() => {
    let widgetId: string | undefined;
    let cancelled = false;

    loadTurnstile().then(
      (turnstile) => {
        if (cancelled || !container.current) {
          return;
        }
        widgetId = turnstile.render(container.current, {
          sitekey: siteKey,
          action: MAGIC_LINK_ACTION,
          theme: "auto",
          "refresh-expired": "auto",
          callback: () => setProblem(null),
          "error-callback": () => {
            setProblem("retrying");
            // Handled: Cloudflare need not log it as well.
            return true;
          },
        });
      },
      () => {
        if (!cancelled) {
          setProblem("unavailable");
        }
      },
    );

    return () => {
      cancelled = true;
      if (widgetId !== undefined) {
        window.turnstile?.remove(widgetId);
      }
    };
  }, [siteKey]);

  return (
    <div
      role="group"
      aria-label="Security check"
      aria-describedby={descriptionId}
      className="space-y-2"
    >
      <p id={descriptionId} className="text-sm text-slate-700">
        This confirms a person is asking for the link. It is provided by
        Cloudflare.
      </p>
      {/* An alert, because the form's status message still asks for the
          check: without an announcement, a screen-reader user would never
          learn it failed, and a failed widget has nothing to tab to. */}
      {problem ? (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
        >
          {problem === "unavailable"
            ? "Problem: the security check could not load. Try again in a few minutes, or sign in with Google below."
            : "Problem: the security check did not complete. It is trying again; if it keeps failing, sign in with Google below."}
        </p>
      ) : null}
      <div ref={container} />
    </div>
  );
}
