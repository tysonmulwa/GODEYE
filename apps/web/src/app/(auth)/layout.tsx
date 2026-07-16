"use client";

import { motion } from "framer-motion";
import { Eye } from "lucide-react";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface p-4">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
        className="w-full max-w-md"
      >
        <div className="mb-8 flex items-center justify-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-white">
            <Eye className="h-5 w-5" />
          </div>
          <span className="text-lg font-semibold tracking-tight">GODEYE</span>
        </div>
        {children}
      </motion.div>
    </div>
  );
}
