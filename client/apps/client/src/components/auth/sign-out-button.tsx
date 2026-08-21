"use client";

import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/server-api";
import { Button } from "@/components/ui/button";

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
  const router = useRouter();

  return (
    <Button
      onClick={async () => {
        await fetch(apiUrl("/api/auth/logout"), {
          method: "POST",
          credentials: "include",
        });
        router.refresh();
        router.push("/");
      }}
      variant="outline"
    >
      <SignOutIcon />
      Sign out
    </Button>
  );
}
