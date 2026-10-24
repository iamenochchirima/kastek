import { useSyncExternalStore } from "react";
import {
  applyTheme,
  resolveStoredTheme,
  serverThemeSnapshot,
  subscribeToThemeChange,
} from "@/lib/theme";

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.3M12 19.2v2.3M21.5 12h-2.3M4.8 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9 5.3 5.3" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
      <path d="M19 14.6A7.5 7.5 0 1 1 9.4 5a8 8 0 0 0 9.6 9.6Z" />
    </svg>
  );
}

export default function ThemeToggle() {
  const theme = useSyncExternalStore(
    subscribeToThemeChange,
    resolveStoredTheme,
    serverThemeSnapshot,
  );

  function toggleTheme() {
    const nextTheme = theme === "dark" ? "light" : "dark";
    applyTheme(nextTheme);
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      aria-pressed={theme === "dark"}
      className="inline-flex h-11 items-center gap-2 rounded-md border border-border/80 bg-card/90 px-3.5 text-sm font-medium text-foreground shadow-[var(--shadow-panel)] backdrop-blur-xl transition-colors hover:border-primary/30 hover:text-primary"
    >
      <span>{theme === "dark" ? <SunIcon /> : <MoonIcon />}</span>
      <span>{theme === "dark" ? "Light" : "Dark"}</span>
    </button>
  );
}
