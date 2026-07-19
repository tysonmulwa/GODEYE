import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Michroma } from "next/font/google";
import { Providers } from "@/lib/providers";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains-mono" });
const michroma = Michroma({ subsets: ["latin"], weight: "400", variable: "--font-michroma" });

export const metadata: Metadata = {
  title: "GODEYE — AI Marketing OS",
  description:
    "Connect your business. Set your goals. GODEYE's AI agents handle content, publishing, SEO, and growth.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} ${michroma.variable}`}
      suppressHydrationWarning
    >
      <body className="font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
