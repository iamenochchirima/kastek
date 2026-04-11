"use client";

import { useRouter } from "next/navigation";
import ThemeToggle from "@/components/theme-toggle";

export default function Header({ userName }: { userName: string }) {
  const router = useRouter();

  async function handleSignOut() {
    await fetch("/api/core/admin/logout", { method: "POST", credentials: "include" });
    router.push("/login");
  }

  return (
    <header className="h-16 bg-surface-raised border-b border-border flex items-center justify-between px-8">
      <div />
      <div className="flex items-center gap-4">
        <ThemeToggle />
        <span className="text-sm text-text-muted">{userName}</span>
        <button
          onClick={handleSignOut}
          className="text-sm text-text-faint hover:text-text transition-colors"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
