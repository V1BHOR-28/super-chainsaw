import type { Metadata, Viewport } from "next";
import { Space_Grotesk, JetBrains_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { Providers } from "@/components/providers";
import { MobileBoot } from "@/components/mobile-boot";
import { PWARegister } from "@/components/pwa-register";

const grotesk = Space_Grotesk({
  variable: "--font-grotesk",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  weight: ["400", "500"],
});

const instrument = Instrument_Serif({
  variable: "--font-instrument",
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "ARIA",
  description:
    "ARIA (Autonomous Reasoning Intelligent Assistant) is not a chatbot — she's a partner. She remembers the shape of your thinking, pushes back when ideas have holes, and stays with you across every conversation.",
  applicationName: "ARIA",
  keywords: ["ARIA", "AI partner", "AI companion", "thinking partner", "LLM", "personal AI", "audiobook"],
  authors: [{ name: "ARIA" }],
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/icon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/icons/icon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192x192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512x512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [
      { url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
      { url: "/icons/icon-167x167.png", sizes: "167x167", type: "image/png" },
    ],
    shortcut: [{ url: "/icons/icon-192x192.png", sizes: "192x192", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "ARIA",
  },
  openGraph: {
    title: "ARIA",
    description: "Not a chatbot. A partner that remembers the shape of your thinking.",
    type: "website",
    siteName: "ARIA",
    images: [{ url: "/icons/og-image.png", width: 1200, height: 630, alt: "ARIA" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "ARIA",
    description: "Not a chatbot. A partner that remembers the shape of your thinking.",
    images: ["/icons/og-image.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#0c0a08",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  // Required for iOS WebView — lets content extend under the notch
  viewportFit: "cover",
};

// iOS PWA splash-screen links — must be raw <link> tags because Next.js
// Metadata API doesn't support `media` attribute on `apple-touch-startup-image`.
// Each link targets a specific device pixel resolution.
const IOS_SPLASH_SCREENS: { media: string; href: string }[] = [
  // 6.7" iPhone 14/15 Pro Max & Plus
  {
    media:
      "(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3)",
    href: "/icons/splash-1290x2796.png",
  },
  // 6.5" iPhone 13/14 Plus, 12/13 Pro Max
  {
    media:
      "(device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3)",
    href: "/icons/splash-1284x2778.png",
  },
  // 6.1" iPhone 14/15 Pro
  {
    media:
      "(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3)",
    href: "/icons/splash-1179x2556.png",
  },
  // 6.1" iPhone 12/13/14/15 (non-Pro)
  {
    media:
      "(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3)",
    href: "/icons/splash-1170x2532.png",
  },
  // 6.5" iPhone XS Max / 11 Pro Max
  {
    media:
      "(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 3)",
    href: "/icons/splash-1242x2688.png",
  },
  // 5.8" iPhone X/XS/11 Pro
  {
    media:
      "(device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3)",
    href: "/icons/splash-1125x2436.png",
  },
  // 6.1" iPhone XR / 11
  {
    media:
      "(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2)",
    href: "/icons/splash-828x1792.png",
  },
  // 5.4" iPhone 12/13 mini
  {
    media:
      "(device-width: 360px) and (device-height: 780px) and (-webkit-device-pixel-ratio: 3)",
    href: "/icons/splash-1080x2340.png",
  },
  // iPad Pro 12.9"
  {
    media:
      "(device-width: 1024px) and (device-height: 1366px) and (-webkit-device-pixel-ratio: 2)",
    href: "/icons/splash-2048x2732.png",
  },
  // iPad Pro 11"
  {
    media:
      "(device-width: 834px) and (device-height: 1194px) and (-webkit-device-pixel-ratio: 2)",
    href: "/icons/splash-1668x2388.png",
  },
];

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className="dark">
      <head>
        {/* iOS PWA standalone splash screens — raw <link> because Next.js
            Metadata API doesn't support `media` attribute on these. */}
        {IOS_SPLASH_SCREENS.map((s) => (
          <link
            key={s.href}
            rel="apple-touch-startup-image"
            media={s.media}
            href={s.href}
          />
        ))}
      </head>
      <body
        className={`${grotesk.variable} ${jetbrains.variable} ${instrument.variable} antialiased aria-grain`}
      >
        <MobileBoot />
        <PWARegister />
        <Providers>
          {children}
        </Providers>
        <Toaster
          position="bottom-right"
          toastOptions={{
            style: {
              background: "var(--aria-bg-soft)",
              border: "1px solid var(--aria-border)",
              color: "var(--aria-fg)",
            },
          }}
        />
      </body>
    </html>
  );
}
