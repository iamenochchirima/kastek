"use client";

import { signOut } from "next-auth/react";

export default function Header({ userName }: { userName: string }) {
  return (
    <header className="h-16 bg-surface-raised border-b border-border flex items-center justify-between px-8">
      <div />
      <div className="flex items-center gap-4">
        <span className="text-sm text-text-muted">{userName}</span>
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="text-sm text-text-faint hover:text-text transition-colors"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
