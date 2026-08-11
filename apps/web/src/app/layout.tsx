import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Michroma } from "next/font/google";
import { Providers } from "@/lib/providers";
import { PLANS } from "@godeye/shared";
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

/**
 * What the product is and what it costs, in the form a search engine reads.
 *
 * The Organization block alone says a company exists; it says nothing about
 * software, price or plan, so nothing could be shown as a product result. The
 * offers are built from the same catalogue that seeds the database and renders
 * the pricing page, so a price cannot be advertised here that nobody is
 * charged — which is the failure mode worth engineering against, since it is
 * both a bad search result and a false claim.
 */
const softwareJsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: SITE_NAME,
  description: SITE_DESCRIPTION,
  url: SITE_URL,
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  offers: PLANS.map((plan) => ({
    "@type": "Offer",
    name: plan.name,
    price: plan.priceMonthlyUsd.toFixed(2),
    priceCurrency: "USD",
    description: plan.tagline,
    url: `${SITE_URL}/pricing`,
  })),
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
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareJsonLd) }}
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
