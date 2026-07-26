"use client";

import Link from "next/link";
import { useState } from "react";
import { apiUrl } from "@/lib/server-api";

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
      {verified ? <><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Email verified</p><h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">You&apos;re ready to sign in</h1><p className="mt-2 text-muted-foreground">Your email is confirmed. Sign in to continue to your workspace.</p></div><Link href="/login?verified=true" className="block w-full rounded-full bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90">Continue to Sign In</Link></> : <><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">One more step</p><h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">Verify your email</h1><p className="mt-2 text-muted-foreground">Open the verification link in your inbox before signing in. If it is missing or expired, send a new one below.</p></div><label className="block text-left text-sm font-medium text-foreground">Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="your@email.com" className="mt-1.5 w-full rounded-xl border border-border bg-secondary px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none" /></label>{status ? <p className="rounded-lg border border-primary/20 bg-primary/10 px-3 py-2 text-sm text-primary">{status}</p> : null}{error ? <p className="rounded-lg border border-destructive/30 bg-status-danger-soft px-3 py-2 text-sm text-destructive">{error}</p> : null}<button type="button" onClick={resend} disabled={sending} className="w-full rounded-full bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50">{sending ? "Sending…" : "Send verification link"}</button><Link href="/login" className="inline-block text-sm text-primary hover:underline">Back to Sign In</Link></>}
    </div>
  );
}
