import { requireDashboardSession } from "@/lib/auth/require-session";

/**
 * Every route in the dashboard group renders only for a verified session. The
 * proxy checks too, but that is defense in depth; this is the server-side
 * enforcement the dashboard relies on.
 */
export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  await requireDashboardSession();

  return children;
}
