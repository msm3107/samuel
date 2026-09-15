import type { Metadata } from "next";

import "./globals.css";

/**
 * The Content-Security-Policy in proxy.ts carries a per-request nonce, and
 * Next.js can only stamp that nonce onto its own script tags while rendering
 * dynamically. A statically prerendered page would be served with a cached
 * nonce that never matches the response header, so every script on it would be
 * blocked. Nothing in a per-tenant dashboard benefits from static caching, so
 * dynamic rendering is the deliberate trade.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Article50.js",
  description:
    "AI transparency infrastructure: disclosure widget, deployment verification, and evidence history.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-slate-900 antialiased">
        {children}
      </body>
    </html>
  );
}
