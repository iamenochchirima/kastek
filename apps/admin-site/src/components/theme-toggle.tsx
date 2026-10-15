"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { buttonClassName } from "@/components/ui/button";
import { applyTheme, resolveStoredTheme, serverThemeSnapshot, subscribeToThemeChange } from "@/lib/appearance";

export default function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeToThemeChange, resolveStoredTheme, serverThemeSnapshot);

  function toggleTheme() {
    applyTheme(theme === "dark" ? "light" : "dark");
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      aria-pressed={theme === "dark"}
      suppressHydrationWarning
      className={buttonClassName({ variant: "ghost", size: "md", className: "gap-1.5 px-2.5" })}
    >
      {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
      <span className="hidden sm:inline" suppressHydrationWarning>{theme === "dark" ? "Light" : "Dark"}</span>
    </button>
  );
}
