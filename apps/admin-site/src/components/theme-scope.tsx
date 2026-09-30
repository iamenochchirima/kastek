"use client";

import { useEffect } from "react";
import { initializeAppearance } from "@/lib/appearance";

export default function ThemeScope() {
  useEffect(() => {
    initializeAppearance();
  }, []);

  return null;
}
