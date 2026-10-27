export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";
export type Density = "comfortable" | "compact";
export type AccentId = "blue" | "indigo" | "violet" | "cyan" | "emerald" | "rose";

export interface InterfacePreferences {
  reduceMotion: boolean;
  liveIndicators: boolean;
  weekStartsMonday: boolean;
}

export interface AppearancePreferences {
  theme: ThemeMode;
  accent: AccentId;
  density: Density;
  interface: InterfacePreferences;
}

export interface AccentTokens {
  base: string;
  strong: string;
  soft: string;
}

export interface AccentPreset {
  id: AccentId;
  name: string;
  swatch: string;
  light: AccentTokens;
  dark: AccentTokens;
}

export const ACCENTS: readonly AccentPreset[] = [
  {
    id: "blue",
    name: "Blue",
    swatch: "#2569D2",
    light: { base: "#2569D2", strong: "#1C56B3", soft: "rgba(37, 105, 210, 0.10)" },
    dark: { base: "#5099F8", strong: "#1E60C8", soft: "rgba(80, 153, 248, 0.12)" },
  },
  {
    id: "indigo",
    name: "Indigo",
    swatch: "#5B5BF0",
    light: { base: "#5B5BF0", strong: "#4A46E8", soft: "rgba(91, 91, 240, 0.10)" },
    dark: { base: "#818CF8", strong: "#6366F1", soft: "rgba(129, 140, 248, 0.12)" },
  },
  {
    id: "violet",
    name: "Violet",
    swatch: "#8B5CF6",
    light: { base: "#8B5CF6", strong: "#7C3AED", soft: "rgba(139, 92, 246, 0.10)" },
    dark: { base: "#A78BFA", strong: "#8B5CF6", soft: "rgba(167, 139, 250, 0.12)" },
  },
  {
    id: "cyan",
    name: "Cyan",
    swatch: "#0EA5E9",
    light: { base: "#0EA5E9", strong: "#0284C7", soft: "rgba(14, 165, 233, 0.10)" },
    dark: { base: "#38BDF8", strong: "#0EA5E9", soft: "rgba(56, 189, 248, 0.12)" },
  },
  {
    id: "emerald",
    name: "Emerald",
    swatch: "#10B981",
    light: { base: "#10B981", strong: "#059669", soft: "rgba(16, 185, 129, 0.10)" },
    dark: { base: "#34D399", strong: "#10B981", soft: "rgba(52, 211, 153, 0.12)" },
  },
  {
    id: "rose",
    name: "Rose",
    swatch: "#F43F5E",
    light: { base: "#F43F5E", strong: "#E11D48", soft: "rgba(244, 63, 94, 0.10)" },
    dark: { base: "#FB7185", strong: "#F43F5E", soft: "rgba(251, 113, 133, 0.12)" },
  },
] as const;

export const APPEARANCE_STORAGE_KEYS = {
  theme: "kasitek-theme",
  accent: "kasitek-accent",
  density: "kasitek-density",
  reduceMotion: "kasitek-pref-reduce-motion",
  liveIndicators: "kasitek-pref-live-indicators",
  weekStartsMonday: "kasitek-pref-week-monday",
} as const;

/** The default applies only when no valid explicit accent was saved. */
export const DEFAULT_ACCENT = "blue" as const;
export const WORKSPACE_PALETTE = {
 light: {canvas:"#FFFFFF",surface:"#FFFFFF",surface2:"#F5F6F7",line:"#E8EAED",ink:"#191B1F",muted:"#62686F"},
 dark: {canvas:"#111316",surface:"#16191D",surface2:"#202328",line:"#2C3036",ink:"#F2F3F5",muted:"#A5ABB3"},
} as const;
