"use client";

import "./globals.css";

/**
 * Replaces the root layout when that layout itself fails, so it renders its
 * own document. Same rule as `app/error.tsx`: the digest as a reference, never
 * the error's message.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-slate-900 antialiased">
        <main className="mx-auto max-w-md px-6 py-24">
          <h1 className="text-2xl font-semibold tracking-tight">
            Something went wrong
          </h1>
          <p className="mt-4 text-slate-700">
            Please try again. If it keeps happening, contact support and quote
            the reference below.
          </p>
          {error.digest ? (
            <p className="mt-4 text-sm text-slate-600">
              Reference: <code>{error.digest}</code>
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            className="mt-6 rounded-md bg-slate-900 px-4 py-2 font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
