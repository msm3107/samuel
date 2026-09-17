import { startGoogleSignInAction } from "@/lib/auth/sign-in/actions";

/**
 * A form rather than a link, so starting a sign-in is a POST that Next.js
 * origin-checks, and so the PKCE verifier cookie is written before the browser
 * leaves for Google.
 */
export function GoogleSignInForm() {
  return (
    <form action={startGoogleSignInAction} className="mt-4">
      <button
        type="submit"
        className="w-full rounded-md border border-slate-300 px-4 py-2 font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
      >
        Continue with Google
      </button>
    </form>
  );
}
