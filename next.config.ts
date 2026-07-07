import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Force Node.js runtime for all API routes (Prisma requires Node.js, not Edge)
  experimental: {
    // Next.js 16: serverComponentsExternalPackages replaces serverExternalPackages
    serverComponentsExternalPackages: ["@prisma/client", "bcryptjs", "resend"],
  },
};

export default nextConfig;
