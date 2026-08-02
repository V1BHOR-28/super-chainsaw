import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Force Node.js runtime for all API routes (Prisma requires Node.js, not Edge)
  // Next.js 16: serverExternalPackages is the new top-level key (replaces
  // experimental.serverComponentsExternalPackages from Next.js 15)
  serverExternalPackages: ["@prisma/client", "bcryptjs", "resend", "nodemailer", "epub2", "bluebird", "cheerio", "kokoro-js", "@huggingface/transformers", "onnxruntime-node", "sharp"],
};

export default nextConfig;
