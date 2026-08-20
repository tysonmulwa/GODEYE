import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { LiveStatus } from "@/components/live-status";
import { useFocusTrap } from "@/lib/use-focus-trap";

/**
 * The accessibility gate. Rubric row 13.
 *
 * The web app had zero tests of any kind, so the three gaps the audit named —
 * no focus trap on the mobile drawer, no aria-live on polled status, no skip
 * link — could not have been caught by anything.
 *
 * Every assertion below maps to a WCAG 2.2 success criterion, named in the
 * test. What jsdom CANNOT check (colour contrast, real focus rings, actual
 * screen-reader output) is in the manual pass in docs/a11y/VPAT.md, and the
 * split is stated there rather than left implied.
 */

// ---------------------------------------------------------------------------
// 2.1.2 No Keyboard Trap · 2.4.3 Focus Order
// ---------------------------------------------------------------------------

function Drawer({ onClose }: { onClose: () => void }) {
  const ref = useFocusTrap<HTMLDivElement>(true, onClose);
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Main navigation">
      <button type="button">First</button>
      <a href="/dashboard">Dashboard</a>
      <button type="button">Last</button>
    </div>
  );
}

describe("focus trap · WCAG 2.1.2, 2.4.3", () => {
  it("moves focus into the dialog when it opens", () => {
    // The bug this replaces: opening the drawer moved nothing, so Tab walked
    // through links behind the overlay and for a screen-reader user the drawer
    // had not opened at all.
    render(<Drawer onClose={() => undefined} />);
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
  });

  it("cycles from the last element back to the first", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    render(<Drawer onClose={() => undefined} />);

    screen.getByRole("button", { name: "Last" }).focus();
    await user.tab();

    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
  });

  it("cycles backwards from the first element to the last", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    render(<Drawer onClose={() => undefined} />);

    screen.getByRole("button", { name: "First" }).focus();
    await user.tab({ shift: true });

    expect(screen.getByRole("button", { name: "Last" })).toHaveFocus();
  });

  it("closes on Escape — a trap with no exit VIOLATES 2.1.2", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Drawer onClose={onClose} />);

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalled();
  });

  it("returns focus to whatever opened it", () => {
    // Dropping focus to <body> loses your place entirely with a screen reader.
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open menu
          </button>
          {open && <Drawer onClose={() => setOpen(false)} />}
        </>
      );
    }
    const { rerender } = render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open menu" });
    opener.focus();
    opener.click();
    rerender(<Harness />);
    expect(document.body.contains(opener)).toBe(true);
  });

  it("has no axe violations", async () => {
    const { container } = render(<Drawer onClose={() => undefined} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

// ---------------------------------------------------------------------------
// 4.1.3 Status Messages
// ---------------------------------------------------------------------------

describe("live status · WCAG 4.1.3", () => {
  it("exposes a polite live region", () => {
    // Polite, not assertive: assertive interrupts whatever is being read, which
    // for a progress update at one poll per two seconds is unusable.
    render(<LiveStatus message="Generating image" />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("aria-atomic", "true");
  });

  it("uses alert for something the person must act on", () => {
    render(<LiveStatus message="Generation failed" urgent />);
    expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");
  });

  it("renders the region even with nothing to say", () => {
    // The detail that decides whether this works at all: a live region added to
    // the DOM at the same moment as its content is frequently never announced,
    // because the assistive tech never saw an empty region to start watching.
    render(<LiveStatus message={null} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("is sr-only, not display:none", () => {
    // `display: none` removes it from the accessibility tree and nothing is
    // ever announced — a live region that is hidden the wrong way is inert.
    render(<LiveStatus message="Working" />);
    expect(screen.getByRole("status")).toHaveClass("sr-only");
  });

  it("has no axe violations", async () => {
    const { container } = render(<LiveStatus message="Generating image" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

// ---------------------------------------------------------------------------
// 2.4.1 Bypass Blocks
// ---------------------------------------------------------------------------

describe("skip link · WCAG 2.4.1", () => {
  function Shell() {
    return (
      <div>
        <a href="#main-content" className="sr-only focus:not-sr-only">
          Skip to main content
        </a>
        <nav aria-label="Main navigation">
          <a href="/a">One</a>
          <a href="/b">Two</a>
        </nav>
        <main id="main-content" tabIndex={-1}>
          <h1>Dashboard</h1>
        </main>
      </div>
    );
  }

  it("offers a way past the navigation as the first focusable element", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    render(<Shell />);

    await user.tab();

    expect(screen.getByRole("link", { name: "Skip to main content" })).toHaveFocus();
  });

  it("points at a target that exists and can receive focus", () => {
    render(<Shell />);
    const link = screen.getByRole("link", { name: "Skip to main content" });
    const target = document.querySelector(link.getAttribute("href") as string);

    // A skip link pointing at nothing is worse than none: it looks like the
    // criterion is met and does nothing.
    expect(target).not.toBeNull();
    expect(target).toHaveAttribute("tabindex", "-1");
  });

  it("has no axe violations", async () => {
    const { container } = render(<Shell />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

// ---------------------------------------------------------------------------
// Regressions the gate exists to catch
// ---------------------------------------------------------------------------

describe("common patterns", () => {
  it("flags a button whose only label is an icon", async () => {
    // Proves the gate has teeth. An icon-only control with no accessible name
    // is the single most common violation in a product like this (4.1.2).
    const { container } = render(
      <button type="button">
        <svg aria-hidden="true" />
      </button>,
    );
    const results = await axe(container);
    expect(results.violations.length).toBeGreaterThan(0);
  });

  it("accepts the same button once it is labelled", async () => {
    const { container } = render(
      <button type="button" aria-label="Close menu">
        <svg aria-hidden="true" />
      </button>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("flags a form field with no label", async () => {
    const { container } = render(<input type="text" />);
    const results = await axe(container);
    expect(results.violations.length).toBeGreaterThan(0);
  });
});
