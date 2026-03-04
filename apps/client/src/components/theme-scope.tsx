"use client";

import { useEffect } from "react";

type ThemeMode = "dark" | "stored";

const storageKey = "kasiai-theme";

function getStoredTheme() {
  if (typeof window === "undefined") return "dark";
  const stored = window.localStorage.getItem(storageKey);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function ThemeScope({ mode }: { mode: ThemeMode }) {
  useEffect(() => {
    const nextTheme = mode === "dark" ? "dark" : getStoredTheme();
    document.documentElement.dataset.theme = nextTheme;
  }, [mode]);

  return null;
}
