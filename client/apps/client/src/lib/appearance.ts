import { useEffect, useSyncExternalStore } from "react";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";
export type Density = "comfortable" | "compact";
export type AccentId = "indigo" | "violet" | "cyan" | "emerald" | "rose";

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

export const DEFAULT_APPEARANCE: AppearancePreferences = {
  theme: "system",
  accent: "indigo",
  density: "comfortable",
  interface: {
    reduceMotion: false,
    liveIndicators: true,
    weekStartsMonday: false,
  },
};

export const APPEARANCE_STORAGE_KEYS = {
  theme: "kasitek-theme",
  accent: "kasitek-accent",
  density: "kasitek-density",
  reduceMotion: "kasitek-pref-reduce-motion",
  liveIndicators: "kasitek-pref-live-indicators",
  weekStartsMonday: "kasitek-pref-week-monday",
} as const;

const APPEARANCE_CHANGE_EVENT = "kasitek-appearance-change";
const THEME_CHANGE_EVENT = "kasitek-theme-change";

function readStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private browsing and blocked storage should not disable the app.
  }
}

function isAccent(value: string | null): value is AccentId {
  return Boolean(value && ACCENTS.some((accent) => accent.id === value));
}

function readStoredAppearance(): AppearancePreferences {
  const theme = readStorage(APPEARANCE_STORAGE_KEYS.theme);
  const density = readStorage(APPEARANCE_STORAGE_KEYS.density);
  const accent = readStorage(APPEARANCE_STORAGE_KEYS.accent);

  return {
    theme: theme === "light" || theme === "dark" || theme === "system" ? theme : DEFAULT_APPEARANCE.theme,
    accent: isAccent(accent) ? accent : DEFAULT_APPEARANCE.accent,
    density: density === "compact" || density === "comfortable" ? density : DEFAULT_APPEARANCE.density,
    interface: {
      reduceMotion: readStorage(APPEARANCE_STORAGE_KEYS.reduceMotion) === "1",
      liveIndicators: readStorage(APPEARANCE_STORAGE_KEYS.liveIndicators) !== "0",
      weekStartsMonday: readStorage(APPEARANCE_STORAGE_KEYS.weekStartsMonday) === "1",
    },
  };
}

export function resolveTheme(theme: ThemeMode): ResolvedTheme {
  if (theme !== "system") return theme;
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function accentTokens(preferences: AppearancePreferences) {
  const preset = ACCENTS.find((accent) => accent.id === preferences.accent) ?? ACCENTS[0];
  return resolveTheme(preferences.theme) === "dark" ? preset.dark : preset.light;
}

export function applyAppearanceToDom(preferences: AppearancePreferences) {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  const resolvedTheme = resolveTheme(preferences.theme);
  const tokens = accentTokens(preferences);

  root.dataset.theme = resolvedTheme;
  root.dataset.themeMode = preferences.theme;
  root.dataset.accent = preferences.accent;
  root.dataset.density = preferences.density;
  root.classList.toggle("dark", resolvedTheme === "dark");
  root.classList.toggle("v-reduce-motion", preferences.interface.reduceMotion);
  root.classList.toggle("v-hide-live", !preferences.interface.liveIndicators);

  root.style.setProperty("--brand", tokens.base);
  root.style.setProperty("--brand-strong", tokens.strong);
  root.style.setProperty("--brand-soft", tokens.soft);
  root.style.setProperty("--appearance-accent", tokens.base);
  root.style.setProperty("--appearance-accent-strong", tokens.strong);
  root.style.setProperty("--appearance-accent-soft", tokens.soft);
  root.style.setProperty("--chart-1", tokens.base);
}

function emit() {
  listeners.forEach((listener) => listener());
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(APPEARANCE_CHANGE_EVENT));
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  }
}

const listeners = new Set<() => void>();
let state: AppearancePreferences = readStoredAppearance();
let initialized = false;

function persistAppearance(preferences: AppearancePreferences) {
  writeStorage(APPEARANCE_STORAGE_KEYS.theme, preferences.theme);
  writeStorage(APPEARANCE_STORAGE_KEYS.accent, preferences.accent);
  writeStorage(APPEARANCE_STORAGE_KEYS.density, preferences.density);
  writeStorage(APPEARANCE_STORAGE_KEYS.reduceMotion, preferences.interface.reduceMotion ? "1" : "0");
  writeStorage(APPEARANCE_STORAGE_KEYS.liveIndicators, preferences.interface.liveIndicators ? "1" : "0");
  writeStorage(APPEARANCE_STORAGE_KEYS.weekStartsMonday, preferences.interface.weekStartsMonday ? "1" : "0");
}

function normalizeAppearance(next: Partial<AppearancePreferences>): AppearancePreferences {
  const theme = next.theme === "light" || next.theme === "dark" || next.theme === "system"
    ? next.theme
    : state.theme;
  const accent = next.accent && isAccent(next.accent) ? next.accent : state.accent;
  const density = next.density === "compact" || next.density === "comfortable"
    ? next.density
    : state.density;

  return {
    theme,
    accent,
    density,
    interface: {
      reduceMotion: typeof next.interface?.reduceMotion === "boolean"
        ? next.interface.reduceMotion
        : state.interface.reduceMotion,
      liveIndicators: typeof next.interface?.liveIndicators === "boolean"
        ? next.interface.liveIndicators
        : state.interface.liveIndicators,
      weekStartsMonday: typeof next.interface?.weekStartsMonday === "boolean"
        ? next.interface.weekStartsMonday
        : state.interface.weekStartsMonday,
    },
  };
}

export function initializeAppearance() {
  if (typeof window === "undefined" || initialized) return;
  initialized = true;
  state = readStoredAppearance();
  applyAppearanceToDom(state);

  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const handleSystemTheme = () => {
    if (state.theme === "system") {
      applyAppearanceToDom(state);
      emit();
    }
  };
  media.addEventListener("change", handleSystemTheme);

  const handleStorage = (event: StorageEvent) => {
    const keys = Object.values(APPEARANCE_STORAGE_KEYS) as string[];
    if (event.key && keys.includes(event.key)) {
      state = readStoredAppearance();
      applyAppearanceToDom(state);
      emit();
    }
  };
  window.addEventListener("storage", handleStorage);
}

export function getAppearance(): AppearancePreferences {
  return state;
}

export function setAppearance(next: Partial<AppearancePreferences>) {
  initializeAppearance();
  state = normalizeAppearance(next);
  persistAppearance(state);
  applyAppearanceToDom(state);
  emit();
}

export function setTheme(theme: ThemeMode) {
  setAppearance({ theme });
}

export function setAccent(accent: AccentId) {
  if (!ACCENTS.some((preset) => preset.id === accent)) return;
  setAppearance({ accent });
}

export function setDensity(density: Density) {
  if (density !== "comfortable" && density !== "compact") return;
  setAppearance({ density });
}

export function setInterfacePreference(key: keyof InterfacePreferences, value: boolean) {
  setAppearance({ interface: { ...state.interface, [key]: value } });
}

export function subscribeToAppearanceChange(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function subscribeToThemeChange(listener: () => void) {
  return subscribeToAppearanceChange(listener);
}

export function useAppearance() {
  useEffect(() => {
    initializeAppearance();
  }, []);

  return useSyncExternalStore(
    subscribeToAppearanceChange,
    getAppearance,
    serverAppearanceSnapshot,
  );
}

export function serverAppearanceSnapshot() {
  return DEFAULT_APPEARANCE;
}

export function resolveStoredTheme(): ResolvedTheme {
  return resolveTheme(state.theme);
}

export function serverThemeSnapshot(): ResolvedTheme {
  return "light";
}

// Compatibility API for existing shell and auth consumers.
export function applyTheme(theme: ResolvedTheme, persist = true) {
  if (persist) {
    setTheme(theme);
    return;
  }
  applyAppearanceToDom({ ...state, theme });
}
