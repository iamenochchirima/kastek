"use client";

import { useEffect } from "react";
import { initializeAppearance } from "@/lib/appearance";

type ThemeMode = "dark" | "stored";

export default function ThemeScope({ mode }: { mode: ThemeMode }) {
  useEffect(() => {
    initializeAppearance();
  }, [mode]);

  return null;
}
