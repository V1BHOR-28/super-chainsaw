import type { NextConfig } from "next";

const isMobileBuild = process.env.NEXT_PUBLIC_MOBILE_APP === "1";

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Force Node.js runtime for all API routes (Prisma requires Node.js, not Edge)
  // Next.js 16: serverExternalPackages is the new top-level key (replaces
  // experimental.serverComponentsExternalPackages from Next.js 15)
  serverExternalPackages: ["@prisma/client", "bcryptjs", "resend", "nodemailer", "epub2", "bluebird", "cheerio"],
  // ─── Mobile-only settings ───
  // When NEXT_PUBLIC_MOBILE_APP=1 (set by `npm run build:mobile`), export the
  // Next.js app as a static bundle so Capacitor can package it. The backend
  // stays on Vercel — the WebView loads `NEXT_PUBLIC_MOBILE_URL` (set as
  // `server.url` in capacitor.config.ts) instead of the local bundle when
  // that env var is present, so the static export is only used for offline
  // fallback / app-store packaging parity.
  ...(isMobileBuild
    ? {
        output: "export" as const,
        images: { unoptimized: true },
        // Capacitor WebViews load from capacitor://localhost or https://localhost
        // — we must mark these as trusted so Next.js Image + Link components
        // don't reject them.
        assetPrefix: undefined,
        trailingSlash: true,
      }
    : {}),
};

export default nextConfig;
