"use client";

import Link from "next/link";
import { useState } from "react";
import { apiUrl } from "@/lib/server-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function VerifyEmailRequest({ initialEmail, verified }: { initialEmail: string; verified: boolean }) {
  const [email, setEmail] = useState(initialEmail);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);

  async function resend() {
    if (!email.trim()) {
      setError("Enter the email address you used to create your account.");
      return;
    }
    setError("");
    setSending(true);
    try {
      const response = await fetch(apiUrl("/api/auth/resend-verification"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "We could not send a verification email.");
      setStatus("If this account still needs verification, a new link is on its way.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "We could not send a verification email.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-5 text-center">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-2xl text-primary">✉️</div>
      {verified ? <><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Email verified</p><h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">You&apos;re ready to sign in</h1><p className="mt-2 text-muted-foreground">Your email is confirmed.</p></div><Button asChild className="w-full"><Link href="/login?verified=true">Continue to sign in</Link></Button></> : <><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">One more step</p><h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">Verify your email</h1><p className="mt-2 text-muted-foreground">Open the verification link in your inbox.</p></div><label className="block text-left text-sm font-medium text-foreground">Email<Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="your@email.com" className="mt-1.5" /></label>{status ? <p className="rounded-lg border border-primary/20 bg-primary/10 px-3 py-2 text-sm text-primary">{status}</p> : null}{error ? <p className="rounded-lg border border-destructive/30 bg-status-danger-soft px-3 py-2 text-sm text-destructive">{error}</p> : null}<Button type="button" onClick={resend} disabled={sending} className="w-full">{sending ? "Sending…" : "Send link"}</Button><Link href="/login" className="inline-block text-sm text-primary hover:underline">Back to sign in</Link></>}
    </div>
  );
}
