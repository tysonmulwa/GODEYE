import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { defineConfig } from "vitest/config";

/**
 * The web app had ZERO tests. This is the first.
 *
 * Deliberately vitest + jsdom rather than Playwright: an accessibility gate has
 * to run on every pull request, and a gate that needs a browser download is a
 * gate somebody eventually marks `continue-on-error`. jsdom cannot check
 * colour contrast or real focus rings — those are in the manual pass in
 * docs/a11y/VPAT.md, and the split is stated there rather than implied.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: { "@": resolve(__dirname, "./src") },
  },
});
