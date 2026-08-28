/**
 * The landing page redesign, pinned.
 *
 * A visual redesign is the single easiest way to silently drop a link, a
 * structured-data block or a meta tag — nothing fails, the page just quietly
 * stops doing something it used to do. Two of the things asserted here were
 * fixed deliberately in earlier work and are easy to undo by accident:
 *
 *   - `og:site_name` on the page metadata. Next REPLACES a page's `openGraph`
 *     object wholesale rather than merging it into the layout's, so overriding
 *     the title to get a decent share card silently removes the site name from
 *     exactly the four pages a search engine indexes.
 *   - `WebSite` JSON-LD on the homepage and nowhere else, because that is where
 *     Google reads the site name from and a second entity makes the signal
 *     ambiguous rather than stronger.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";
import { TRIAL_HOURS } from "@godeye/shared";
import { ClosingCta } from "@/components/marketing/closing-cta";
import { ConnectOnce } from "@/components/marketing/connect-once";
import { Faq } from "@/components/marketing/faq";
import { FeatureBento } from "@/components/marketing/feature-bento";
import { Findable } from "@/components/marketing/findable";
import { Hero } from "@/components/marketing/hero";
import { HowItWorks } from "@/components/marketing/how-it-works";
import { PricingTeaser } from "@/components/marketing/pricing-teaser";
import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteNav } from "@/components/marketing/site-nav";
import { metadata } from "@/app/(marketing)/page";

/*
 * `matchMedia`, `IntersectionObserver` and `ResizeObserver` are all stubbed
 * once in src/test/setup.ts — jsdom implements none of them, and every
 * marketing component needs at least one. Re-stubbing them here throws
 * ("Cannot redefine property"), because the setup file defines them writable
 * but not configurable.
 */

const hrefs = (container: HTMLElement) =>
  [...container.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));

// ---------------------------------------------------------------------------
// Destinations. Every one of these existed before the redesign.
// ---------------------------------------------------------------------------

describe("the links that had to survive", () => {
  it("keeps the primary CTA pointing at /register, with the shared trial length", () => {
    const { container } = render(<Hero />);
    const cta = screen.getByRole("link", { name: `Start free for ${TRIAL_HOURS} hours` });
    expect(cta).toHaveAttribute("href", "/register");
    // Imported from @godeye/shared, never hardcoded: the same constant seeds
    // the API's trial length, and a page that disagrees with it is a support
    // ticket.
    expect(hrefs(container)).toContain("/register");
  });

  it("keeps Pricing and Sign in reachable — moved into the nav, same destinations", () => {
    const { container } = render(<SiteNav />);
    const links = hrefs(container);
    expect(links).toContain("/pricing");
    expect(links).toContain("/login");
    expect(links).toContain("/register");
  });

  it("keeps every footer destination the old page had", () => {
    const { container } = render(<SiteFooter />);
    const links = hrefs(container);
    for (const href of [
      "/pricing",
      "/integrations/tiktok",
      "/integrations/meta",
      "/privacy",
      "/terms",
    ]) {
      expect(links).toContain(href);
    }
  });

  /**
   * The nav must not offer a route that does not exist. There is no /docs page
   * and none is planned, so the nav says Integrations instead — a dead link in
   * the header of a page whose job is credibility is worse than a shorter nav.
   */
  it("links nowhere that does not exist", () => {
    const { container } = render(<SiteNav />);
    const internal = hrefs(container).filter((h) => h?.startsWith("/"));
    const REAL = [
      "/",
      "/pricing",
      "/login",
      "/register",
      "/integrations/tiktok",
      "/integrations/meta",
    ];
    for (const href of internal) {
      const path = href!.split("#")[0] || "/";
      expect(REAL).toContain(path);
    }
  });

  it("sends the secondary hero CTA to a section that is actually on the page", () => {
    render(<Hero />);
    expect(screen.getByRole("link", { name: /see how it works/i })).toHaveAttribute(
      "href",
      "#how-it-works",
    );
    const { container } = render(<HowItWorks />);
    expect(container.querySelector("#how-it-works")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Metadata and structured data
// ---------------------------------------------------------------------------

describe("metadata and structured data", () => {
  it("still repeats og:site_name on the page's own openGraph object", () => {
    // The regression this exists for: Next replaces rather than merges, so
    // dropping this line removes the tag from the indexed pages entirely.
    expect(metadata.openGraph).toBeDefined();
    expect(metadata.openGraph).toHaveProperty("siteName", "GODEYE");
  });

  it("keeps the canonical, the title and the twitter title", () => {
    expect(metadata.alternates?.canonical).toBe("/");
    expect(metadata.title).toBe("Marketing that runs without you in the room");
    expect(metadata.twitter).toHaveProperty(
      "title",
      "Marketing that runs without you in the room",
    );
  });
});

// ---------------------------------------------------------------------------
// Honesty constraints — brief §4
// ---------------------------------------------------------------------------

describe("no invented social proof", () => {
  /**
   * The rule from the brief: any number presented as a company stat must be
   * real or absent. Product UI showing an illustrative score is fine; "10,000+
   * marketers" is not, and is the fastest way to make a good product look
   * untrustworthy.
   */
  it("makes no customer, user or volume claim anywhere on the page", () => {
    const { container } = render(
      <>
        <Hero />
        <ConnectOnce />
        <HowItWorks />
        <FeatureBento />
        <Findable />
        <PricingTeaser />
        <ClosingCta />
      </>,
    );
    const text = container.textContent ?? "";
    for (const pattern of [
      /\d[\d,.]*\s*\+?\s*(customers|users|businesses|marketers|teams|companies)/i,
      /(trusted|loved|used)\s+by\s+[\d,]/i,
      /\d[\d,.]*\s*(million|m|k)?\s*posts\s+published/i,
      /join\s+[\d,]/i,
    ]) {
      expect(text).not.toMatch(pattern);
    }
  });

  it("has no testimonial or customer-logo section", () => {
    const { container } = render(<FeatureBento />);
    expect(container.textContent).not.toMatch(/testimonial|what our customers|as seen in/i);
  });
});

// ---------------------------------------------------------------------------
// Accessibility — WCAG 2.1 AA
// ---------------------------------------------------------------------------

describe("accessibility", () => {
  it.each([
    ["nav", <SiteNav key="n" />],
    ["hero", <Hero key="h" />],
    ["channels", <ConnectOnce key="c" />],
    ["how it works", <HowItWorks key="w" />],
    ["bento", <FeatureBento key="b" />],
    ["findable", <Findable key="f" />],
    ["pricing teaser", <PricingTeaser key="p" />],
    ["closing cta", <ClosingCta key="x" />],
    ["footer", <SiteFooter key="s" />],
  ])("%s has no axe violations", async (_name, node) => {
    const { container } = render(node);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("gives the hero composition a single descriptive label", () => {
    render(<Hero />);
    const composition = screen.getByRole("img");
    // Every moving part inside is decorative; the composition as a whole is
    // what gets described, and it names the channels for anyone who cannot
    // see the orbit.
    expect(composition).toHaveAccessibleName(/TikTok.*Instagram.*Discord/s);
  });

  it("exposes exactly one h1", () => {
    const { container } = render(<Hero />);
    expect(container.querySelectorAll("h1")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Keyboard paths
// ---------------------------------------------------------------------------

describe("keyboard", () => {
  it("opens the mobile drawer, traps focus in it and closes on Escape", async () => {
    const user = userEvent.setup();
    render(<SiteNav />);

    await user.click(screen.getByRole("button", { name: /open menu/i }));
    const drawer = screen.getByRole("dialog", { name: /main navigation/i });
    expect(drawer).toBeInTheDocument();
    // Focus has to move INTO the dialog, or Tab walks the page behind it and
    // for a screen-reader user the drawer never opened.
    expect(drawer.contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes the integrations menu on Escape rather than leaving it over the page", async () => {
    const user = userEvent.setup();
    render(<SiteNav />);

    const trigger = screen.getByRole("button", { name: /integrations/i });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    await user.keyboard("{Escape}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("gives the FAQ a keyboard-operable disclosure per question", async () => {
    const user = userEvent.setup();
    const items = [
      { q: "Which platforms does it publish to?", a: "TikTok, Instagram and others." },
      { q: "How do I cancel?", a: "Any time, from the billing page." },
    ];
    const { container } = render(<Faq items={items} />);

    const details = [...container.querySelectorAll("details")];
    expect(details).toHaveLength(2);

    // <details> is focusable and toggles on Enter and Space with no JS at all,
    // so the accordion works before hydration and if the bundle never arrives.
    details.forEach((d, i) => {
      expect(within(d).getByText(items[i].q)).toBeInTheDocument();
      expect(within(d).getByText(items[i].a)).toBeInTheDocument();
    });

    // Closed by default: every answer expanded is a wall of text, not an FAQ.
    expect(details.every((d) => !d.open)).toBe(true);

    await user.click(within(details[0]).getByText(items[0].q));
    expect(details[0].open).toBe(true);
    expect(details[1].open).toBe(false);
  });
});
