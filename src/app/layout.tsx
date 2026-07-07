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
  title: "ARIA — Your thinking partner",
  description:
    "ARIA (Autonomous Reasoning Intelligent Assistant) is not a chatbot — she's a partner. She remembers the shape of your thinking, pushes back when ideas have holes, and stays with you across every conversation.",
  keywords: ["ARIA", "AI partner", "AI companion", "thinking partner", "LLM", "personal AI"],
  authors: [{ name: "ARIA" }],
  icons: { icon: "/logo.svg" },
  openGraph: {
    title: "ARIA — Your thinking partner",
    description: "Not a chatbot. A partner that remembers the shape of your thinking.",
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
