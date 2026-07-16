export type AppTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "kasitek-theme";

export function resolveStoredTheme(): AppTheme {
  if (typeof window === "undefined") return "light";

  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme: AppTheme, persist = true) {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle("dark", theme === "dark");

  if (persist) {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }
}
