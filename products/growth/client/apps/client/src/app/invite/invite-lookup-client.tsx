"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Mail } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function extractInvitationToken(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed, window.location.origin);
    const match = url.pathname.match(/^\/invite\/([^/]+)\/?$/);
    if (match?.[1]) return decodeURIComponent(match[1]);
  } catch {
    return null;
  }

  if (!trimmed.includes("/") && !/\s/.test(trimmed)) return trimmed;
  return null;
}

export function InviteLookupClient() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = extractInvitationToken(value);
    if (!token) {
      setError("Enter a valid invitation link or token.");
      return;
    }
    setError("");
    router.push("/invite/" + encodeURIComponent(token));
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary">
          <Mail className="h-6 w-6" aria-hidden="true" />
        </div>
        <p className="mt-5 text-xs font-semibold uppercase tracking-[0.18em] text-primary">Organization invitation</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">Redeem invitation</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Paste the invitation link from your email.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="invitation" className="mb-1.5 block text-sm font-medium text-foreground">
            Invitation link or token
          </label>
          <Input
            id="invitation"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setError("");
            }}
            placeholder="https://.../invite/..."
            autoComplete="off"
            autoFocus
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "invitation-error" : undefined}
          />
        </div>
        {error && (
          <p id="invitation-error" role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full">Continue</Button>
      </form>

      <Link href="/login" className="inline-flex w-full items-center justify-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to sign in
      </Link>
    </div>
  );
}
