import type { Transition, Variants } from "framer-motion";

/**
 * Vantage motion contract.
 *
 * Keep interaction timing in one place so shared components do not drift into
 * slightly different durations and easing curves. CSS consumers use the
 * matching --v-motion-* custom properties in globals.css.
 */
export const VANTAGE_MOTION = {
  fast: 150,
  theme: 220,
  shell: 250,
  content: 400,
  ease: "ease",
  pageEase: [0.16, 1, 0.3, 1] as const,
  spring: { type: "spring" as const, stiffness: 300, damping: 30 },
} as const;

export const VANTAGE_EXPO: [number, number, number, number] = [0.16, 1, 0.3, 1];

const FADE_UP_TRANSITION = (delay: number): Transition => ({
  delay,
  duration: VANTAGE_MOTION.content / 1000,
  ease: VANTAGE_EXPO,
});

export function settingsCardVariants(index: number): Variants {
  return {
    hidden: { opacity: 0, y: 12 },
    visible: { opacity: 1, y: 0, transition: FADE_UP_TRANSITION(index * 0.08) },
  };
}

export function settingsModeVariants(index: number): Variants {
  return {
    hidden: { opacity: 0, y: 12 },
    visible: { opacity: 1, y: 0, transition: FADE_UP_TRANSITION(index * 0.07) },
  };
}

export const VANTAGE_DENSITY_TRANSITION: Transition = {
  duration: 0.3,
  ease: VANTAGE_EXPO,
};

export const VANTAGE_SELECTION_SPRING: Transition = {
  type: "spring",
  stiffness: 300,
  damping: 30,
};

export const VANTAGE_DRAWER_VARIANTS: Variants = {
  hidden: { x: "-100%", opacity: 0 },
  visible: { x: 0, opacity: 1, transition: VANTAGE_MOTION.spring },
  exit: { x: "-100%", opacity: 0, transition: { duration: VANTAGE_MOTION.shell / 1000, ease: VANTAGE_EXPO } },
};

export const VANTAGE_BACKDROP_VARIANTS: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: VANTAGE_MOTION.fast / 1000, ease: VANTAGE_EXPO } },
  exit: { opacity: 0, transition: { duration: VANTAGE_MOTION.fast / 1000, ease: VANTAGE_EXPO } },
};

export const VANTAGE_LIST_ITEM_VARIANTS: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: (index = 0) => ({
    opacity: 1,
    y: 0,
    transition: { ...FADE_UP_TRANSITION(Number(index) * 0.04), duration: VANTAGE_MOTION.fast / 1000 },
  }),
};

export const VANTAGE_MENU_VARIANTS: Variants = {
  hidden: { opacity: 0, scale: 0.98, y: -4 },
  visible: { opacity: 1, scale: 1, y: 0, transition: { duration: VANTAGE_MOTION.fast / 1000, ease: VANTAGE_EXPO } },
  exit: { opacity: 0, scale: 0.98, y: -4, transition: { duration: VANTAGE_MOTION.fast / 1000, ease: VANTAGE_EXPO } },
};

export type VantageMotionDuration = keyof Pick<
  typeof VANTAGE_MOTION,
  "fast" | "theme" | "shell" | "content"
>;
