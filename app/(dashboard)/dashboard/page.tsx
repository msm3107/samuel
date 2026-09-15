import { requireDashboardSession } from "@/lib/auth/require-session";

/**
 * Placeholder until the dashboard has content. It renders nothing about the
 * user or any organization, but still checks the session itself: Next.js can
 * render a page without re-running the layout above it, so every dashboard
 * page does its own check. The call is memoized per render, so it costs no
 * second auth-server round trip.
 */
export default async function DashboardPage() {
  await requireDashboardSession();

  return (
    <main className="mx-auto max-w-2xl px-6 py-24">
      <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>

      <p className="mt-4 text-lg text-slate-700">
        You are signed in. Organizations, AI systems, and deployments will
        appear here.
      </p>
    </main>
  );
}
