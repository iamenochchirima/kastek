"use client";

import { motion, MotionConfig } from "framer-motion";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useAppearance } from "@/lib/appearance";
import { VANTAGE_EXPO, VANTAGE_MOTION } from "@/lib/motion";
import { cn } from "@/lib/utils";

type MotionRevealProps = Omit<ComponentPropsWithoutRef<typeof motion.div>, "children"> & {
  children: ReactNode;
  delay?: number;
  hoverLift?: boolean;
};

/** Shared Vantage page/card entrance for server-rendered route content. */
export function MotionReveal({ children, className, delay = 0, hoverLift = false, ...props }: MotionRevealProps) {
  const preferences = useAppearance();

  return (
    <MotionConfig reducedMotion={preferences.interface.reduceMotion ? "always" : "user"}>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay, duration: VANTAGE_MOTION.content / 1000, ease: VANTAGE_EXPO }}
        whileHover={hoverLift ? { y: -2 } : undefined}
        className={cn(className)}
        {...props}
      >
        {children}
      </motion.div>
    </MotionConfig>
  );
}
