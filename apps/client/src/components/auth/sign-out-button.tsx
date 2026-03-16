"use client";

import { signOut } from "next-auth/react";

function SignOutIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
      <path d="M9 4.5H6.5A2.5 2.5 0 0 0 4 7v10a2.5 2.5 0 0 0 2.5 2.5H9" />
      <path d="M14 8.5 19 12l-5 3.5" />
      <path d="M19 12H9" />
    </svg>
  );
}

export default function SignOutButton() {
  return (
    <button
      onClick={() => signOut({ callbackUrl: "/" })}
      className="inline-flex h-11 items-center gap-2 rounded-full border border-border/80 bg-card px-3.5 text-sm font-medium text-muted-foreground transition-colors hover:border-primary/20 hover:bg-secondary/30 hover:text-foreground"
    >
      <SignOutIcon />
      Sign Out
    </button>
  );
}
