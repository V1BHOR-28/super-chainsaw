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
  // Produce a self-contained .next/standalone/ dir at build time. This is the
  // Next.js-recommended pattern for Docker — the final image only needs
  // .next/standalone + .next/static + public/, no node_modules. Cuts the
  // production image from ~1.2GB to ~250MB. See:
  // https://nextjs.org/docs/app/api-reference/config/next-config-js/output
  output: "standalone",
};

export default nextConfig;
