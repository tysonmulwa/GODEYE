"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Light/dark for the marketing pages.
 *
 * Separate from the dashboard's `theme-toggle.tsx`, which writes `.dark` onto
 * <html> and is read by the app's palette. These pages carry their own scope
 * (`.marketing`) so that a visitor's dashboard preference does not decide what
 * a stranger sees on the landing page, and so the two can be styled apart.
 *
 * ## Three states, not two
 *
 * Unset is a real state and the default one. With nothing stored, the CSS
 * decides from `prefers-color-scheme`, so someone on a light machine gets light
 * on first paint with **no flash and no JavaScript at all**. Only once the
 * visitor presses this does `data-theme` get written, and from then on their
 * choice beats the OS in both directions.
 *
 * That is why this reads as "unset" on the server and syncs in an effect: any
 * attempt to render the *current* theme during SSR would either be wrong for
 * half of visitors or force the page out of static generation.
 */
const KEY = "godeye-marketing-theme";

type Choice = "light" | "dark" | null;

function systemPrefersLight(): boolean {
  return window.matchMedia("(prefers-color-scheme: light)").matches;
}

export function ThemeSwitch() {
  const [choice, setChoice] = useState<Choice>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    let stored: Choice = null;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw === "light" || raw === "dark") stored = raw;
    } catch {
      // Private mode, or site data blocked. Falling back to the OS preference
      // is correct here, and a theme toggle is not worth an error boundary.
    }
    setChoice(stored);
    apply(stored);
  }, []);

  function apply(next: Choice) {
    const scope = document.querySelector(".marketing");
    if (!scope) return;
    if (next) scope.setAttribute("data-theme", next);
    else scope.removeAttribute("data-theme");
  }

  function toggle() {
    // With nothing chosen yet, the first press means "the opposite of what I am
    // currently looking at" — which is the OS preference, not a fixed default.
    const current: "light" | "dark" = choice ?? (systemPrefersLight() ? "light" : "dark");
    const next: "light" | "dark" = current === "dark" ? "light" : "dark";
    setChoice(next);
    apply(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Not persisting is a worse experience, not a broken one.
    }
  }

  // Before mount the rendered icon would be a guess, and a wrong guess visibly
  // flips after hydration. Reserve the space, show nothing.
  const isDark = mounted ? (choice ?? (systemPrefersLight() ? "light" : "dark")) === "dark" : true;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-secondary transition-colors hover:text-primary"
    >
      {mounted ? (
        isDark ? (
          <Sun className="h-[18px] w-[18px]" aria-hidden />
        ) : (
          <Moon className="h-[18px] w-[18px]" aria-hidden />
        )
      ) : (
        <span className="h-[18px] w-[18px]" aria-hidden />
      )}
    </button>
  );
}
