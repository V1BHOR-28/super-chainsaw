import type { Metadata, Viewport } from "next";
import { Space_Grotesk, JetBrains_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { Providers } from "@/components/providers";

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
    "Turn any EPUB or PDF into a narrated audiobook with Spotify-style word-by-word transcripts and adaptive background scoring. Free to try.",
  keywords: ["ARIA", "AI partner", "AI companion", "thinking partner", "LLM", "personal AI", "audiobook", "EPUB to audiobook", "text to speech", "transcript sync"],
  authors: [{ name: "ARIA" }],
  icons: { icon: "/aria-logo.png" },
  openGraph: {
    title: "ARIA",
    description: "Turn any EPUB or PDF into a narrated audiobook with Spotify-style word-by-word transcripts and adaptive background scoring. Free to try.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#0c0a08",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className="dark">
      <body
        className={`${grotesk.variable} ${jetbrains.variable} ${instrument.variable} antialiased aria-grain`}
      >
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
