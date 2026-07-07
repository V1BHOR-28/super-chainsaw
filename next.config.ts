import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No "output: standalone" — Vercel handles this automatically.
  // Standalone mode is for Docker/self-hosting, breaks Vercel routing.
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Tell Next.js not to bundle Prisma (it has native engine binaries that
  // can't be bundled by webpack).
  serverExternalPackages: [
    "@prisma/client",
    "bcryptjs",
    "resend",
  ],
};

export default nextConfig;
