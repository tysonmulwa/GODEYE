"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import { GodeyeCrest } from "@/components/logo";
import { Constellation } from "@/components/marketing/constellation";
import { ThemeSync } from "@/components/marketing/theme-switch";

/**
 * Sign in, sign up, and invitation acceptance.
 *
 * These share the public surface with the landing page rather than the
 * dashboard's: someone arriving here has just come from `/`, and a hard cut
 * from a dark constellation to a flat grey form reads as landing on a different
 * product. Same scope, same palette, same background.
 *
 * `.marketing` is the name of that scope, and it is a slightly narrow one: it
 * means "the logged-out surface", which is the landing page, pricing, and these
 * three forms. Renaming it would touch the stylesheet, the token docs and the
 * tests for no behavioural gain, so it is documented instead.
 *
 * There is no theme switch here, only `<ThemeSync />`. A choice made on the
 * landing page has to survive the click into Sign in, or the theme changes
 * under the visitor at exactly the moment they are typing a password.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="marketing relative isolate flex min-h-svh items-center justify-center p-4">
      <ThemeSync />
      <Constellation />

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
        className="w-full max-w-md"
      >
        <div className="mb-8 flex justify-center">
          <Link href="/" aria-label="GODEYE, home">
            <GodeyeCrest size={104} />
          </Link>
        </div>
        {children}
      </motion.div>
    </div>
  );
}
