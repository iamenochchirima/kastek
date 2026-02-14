"use client";

import { signOut } from "next-auth/react";

export default function SignOutButton() {
  return (
    <button
      onClick={() => signOut({ callbackUrl: "/" })}
      className="text-sm text-text-muted transition-colors hover:text-text"
    >
      Sign Out
    </button>
  );
}
