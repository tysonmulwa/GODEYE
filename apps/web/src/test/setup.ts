import "@testing-library/jest-dom/vitest";
import { expect } from "vitest";
import { toHaveNoViolations } from "jest-axe";

expect.extend(toHaveNoViolations);

/**
 * jsdom implements neither of these, and both are load-bearing for the
 * accessibility work: `matchMedia` is how prefers-reduced-motion is read, and
 * IntersectionObserver is used by animation components that would otherwise
 * throw during render and fail a test for the wrong reason.
 */
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
Object.defineProperty(window, "IntersectionObserver", { writable: true, value: NoopObserver });
Object.defineProperty(window, "ResizeObserver", { writable: true, value: NoopObserver });
