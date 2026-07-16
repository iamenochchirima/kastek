"use client";

import { useEffect } from "react";
import { applyTheme, resolveStoredTheme } from "@/lib/theme";

type ThemeMode = "dark" | "stored";

export default function ThemeScope({ mode }: { mode: ThemeMode }) {
  useEffect(() => {
    applyTheme(mode === "dark" ? "dark" : resolveStoredTheme(), false);
  }, [mode]);

  return null;
}
