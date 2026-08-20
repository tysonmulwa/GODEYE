"use client";

import { useEffect, useRef } from "react";

/**
 * Keeps keyboard focus inside an open dialog or drawer, and gives it back.
 *
 * WCAG 2.2 AA: 2.1.2 No Keyboard Trap, 2.4.3 Focus Order, 2.4.7 Focus Visible.
 *
 * Without this, opening the mobile navigation moves nothing: focus stays on the
 * page behind the drawer, so Tab walks through links that are visually covered
 * and, for a screen-reader user, the drawer effectively did not open. Escape
 * does nothing either. That is the whole of the audit's "no focus trap on the
 * mobile drawer".
 *
 * The name is a misnomer everyone uses. A real *trap* would violate 2.1.2 —
 * this cycles within the dialog and always leaves via Escape, which is what the
 * criterion actually requires.
 */

/**
 * Elements that can hold focus. `:not([tabindex="-1"])` matters: an element
 * removed from the tab order deliberately must not be cycled back into it.
 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function useFocusTrap<T extends HTMLElement>(active: boolean, onEscape?: () => void) {
  const ref = useRef<T>(null);
  /** Whatever had focus before the dialog opened, so it can be returned. */
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;

    restoreTo.current = document.activeElement as HTMLElement | null;

    /**
     * A focusable element inside a `display: none` subtree still matches the
     * selector and cannot actually be focused, which leaves Tab apparently
     * doing nothing.
     *
     * Deliberately NOT `offsetParent !== null`, which is the usual shorthand:
     * `offsetParent` is null for any `position: fixed` element, and this
     * drawer is fixed. That check would have filtered out every link in it and
     * trapped focus on the container — caught by
     * "moves focus into the dialog when it opens".
     */
    const isVisible = (el: HTMLElement) => {
      if (el.hasAttribute("hidden") || el.closest("[inert]")) return false;
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden";
    };

    const focusable = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isVisible);

    // Move focus in. Without this the drawer opens and the keyboard is still on
    // the page behind it, which is the bug.
    const first = focusable()[0];
    (first ?? container).focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onEscape?.();
        return;
      }
      if (event.key !== "Tab") return;

      const elements = focusable();
      if (elements.length === 0) {
        // Nothing to move to; keep focus on the container rather than letting
        // it escape to the page behind.
        event.preventDefault();
        return;
      }
      const firstEl = elements[0];
      const lastEl = elements[elements.length - 1];
      const current = document.activeElement;

      if (event.shiftKey && (current === firstEl || current === container)) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && current === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      // Give focus back where it came from. Dropping it to <body> is
      // disorienting with a screen reader and loses your place entirely
      // (WCAG 2.4.3).
      restoreTo.current?.focus?.({ preventScroll: true });
    };
  }, [active, onEscape]);

  return ref;
}
