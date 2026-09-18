import { signOutAction } from "@/lib/auth/sign-in/actions";

/**
 * Ends the session on the auth server and clears it from this browser. A form
 * posting a server action, never a link: signing out changes state, and a GET
 * that did so could be triggered by any page the person visits.
 */
export function SignOutForm() {
  return (
    <form action={signOutAction}>
      <button
        type="submit"
        className="rounded-md border border-slate-500 px-3 py-1.5 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
      >
        Sign out
      </button>
    </form>
  );
}
