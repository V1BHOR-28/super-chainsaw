import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Force Node.js runtime for all API routes (Prisma requires Node.js, not Edge)
  // Next.js 16: serverExternalPackages is the new top-level key (replaces
  // experimental.serverComponentsExternalPackages from Next.js 15)
  serverExternalPackages: ["@prisma/client", "bcryptjs", "resend", "nodemailer", "epub2", "bluebird", "cheerio"],
  // NOTE: We intentionally do NOT use `output: "export"` for mobile builds.
  // The Capacitor WebView loads the deployed Next.js URL directly via
  // `server.url` in capacitor.config.ts — so the local JS bundle is never
  // consumed. Building a static export would fail anyway because the app
  // has many /api/* routes that can't exist in a static export.
  // The CI workflow creates a minimal placeholder out/index.html for the
  // Capacitor project to sync against.
};

export default nextConfig;
