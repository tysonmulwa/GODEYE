import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Michroma } from "next/font/google";
import { Providers } from "@/lib/providers";
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/site";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains-mono" });
const michroma = Michroma({ subsets: ["latin"], weight: "400", variable: "--font-michroma" });

export const metadata: Metadata = {
  // Everything below resolves against this, so a relative canonical or og:url
  // still comes out absolute — which is the only form either is read in.
  metadataBase: new URL(SITE_URL),
  title: { default: SITE_NAME, template: `%s · ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  // Says which address is the real one when a page is reachable several ways —
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

/**
 * Describes the business in the form search engines read directly, rather than
 * inferring. In the root layout so it is on every page.
 *
 * Only claims that are true: a name, what it does, and where it lives. Rich
 * results are withdrawn for structured data that overstates, so ratings and
 * opening hours stay out until there is something real behind them.
 */
const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: SITE_NAME,
  description: SITE_DESCRIPTION,
  url: SITE_URL,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} ${michroma.variable}`}
      suppressHydrationWarning
    >
      <body className="font-sans">
        <script
          type="application/ld+json"
          // Next escapes the string; the JSON is ours, not user input.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
