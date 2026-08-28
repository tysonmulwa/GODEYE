import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Michroma, Space_Grotesk } from "next/font/google";
import { Providers } from "@/lib/providers";
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/site";
import { organizationJsonLd, softwareJsonLd } from "@/lib/structured-data";
import "./globals.css";

/*
 * All four faces are downloaded at build time and served from this origin.
 * next/font/google is not a runtime request to Google — that is why
 * fonts.gstatic.com is deliberately absent from font-src in lib/csp.ts.
 *
 * `adjustFontFallback` (on by default) synthesises a size-adjusted local
 * fallback from each face's metrics, so the swap does not move the text and
 * the page holds CLS near zero while a font is still loading.
 */
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains-mono" });
const michroma = Michroma({ subsets: ["latin"], weight: "400", variable: "--font-michroma" });
/* Display face for marketing headlines. Michroma stays, but only as the
   wordmark's face (--font-brand): it is a wide decorative grotesk that is
   unreadable as a 4.5rem sentence. */
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  display: "swap",
});

export const metadata: Metadata = {
  // Everything below resolves against this, so a relative canonical or og:url
  // still comes out absolute, which is the only form either is read in.
  metadataBase: new URL(SITE_URL),
  title: { default: SITE_NAME, template: `%s · ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  // Says which address is the real one when a page is reachable several ways,
  // with and without a trailing slash, with tracking parameters, http and
  // https. Without it those variants compete with each other.
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    url: "/",
  },
  // Without these the platform guesses at how a shared link looks, and it
  // usually guesses badly.
  twitter: { card: "summary_large_image", title: SITE_NAME, description: SITE_DESCRIPTION },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} ${michroma.variable} ${spaceGrotesk.variable}`}
      suppressHydrationWarning
    >
      <body className="font-sans">
        <script
          type="application/ld+json"
          // Next escapes the string; the JSON is ours, not user input.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareJsonLd) }}
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
