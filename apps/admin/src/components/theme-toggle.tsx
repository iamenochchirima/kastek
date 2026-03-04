"use client";

import { useState } from "react";

type Theme = "light" | "dark";

const storageKey = "kasiai-theme";

function getTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(storageKey);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getTheme);

  function toggleTheme() {
    const nextTheme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = nextTheme;
    window.localStorage.setItem(storageKey, nextTheme);
    setTheme(nextTheme);
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      aria-pressed={theme === "dark"}
      suppressHydrationWarning
      className="inline-flex h-10 items-center gap-2 rounded-full border border-border bg-surface px-3 text-sm font-medium text-text hover:border-primary/40 hover:text-primary"
    >
      <span className="text-base leading-none" suppressHydrationWarning>{theme === "dark" ? "☀" : "☾"}</span>
      <span suppressHydrationWarning>{theme === "dark" ? "Light" : "Dark"}</span>
    </button>
  );
}
