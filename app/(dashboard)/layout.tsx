import { SignOutForm } from "@/components/forms/sign-out-form";
import { requireDashboardSession } from "@/lib/auth/require-session";

/**
 * Every route in the dashboard group renders only for a verified session. The
 * proxy checks too, but that is defense in depth; this is the server-side
 * enforcement the dashboard relies on.
 *
 * The header carries sign-out, so a session can always be ended — on a shared
 * or agency computer especially.
 */
export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  await requireDashboardSession();

  return (
    <>
      <header className="border-b border-slate-200">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
          <span className="font-semibold">Article50.js</span>
          <SignOutForm />
        </div>
      </header>
      {children}
    </>
  );
}
