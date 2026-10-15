"use client";

import Link from "next/link";
import { useState } from "react";
import { buttonClassName } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/core/admin/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Unable to send reset email");
        return;
      }

      setSubmitted(true);
    } catch {
      setError("Unable to send reset email");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <div className="rounded-[calc(var(--radius)-1px)] border border-line bg-card p-6 shadow-pop sm:p-8">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-[-0.025em] text-foreground">Reset admin password</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Enter your admin email and we&apos;ll send a reset link if the account exists.
          </p>
        </div>

        {submitted ? (
          <div className="space-y-4">
            <div className="rounded-md border border-status-success/25 bg-status-success-soft px-4 py-3 text-sm text-status-success">
              If an admin account exists for that email, a reset link has been sent.
            </div>
            <Link href="/login" className="block text-sm text-primary hover:underline">
              Back to sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {error ? (
              <div className="rounded-md border border-status-danger/25 bg-status-danger-soft px-4 py-3 text-sm text-status-danger">
                {error}
              </div>
            ) : null}

            <div>
              <label htmlFor="email" className="mb-1 block text-sm font-medium text-foreground">
                Email
              </label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className={buttonClassName({ className: "w-full" })}
            >
              {loading ? "Sending..." : "Send reset link"}
            </button>

            <Link href="/login" className="block text-center text-sm text-primary hover:underline">
              Back to sign in
            </Link>
          </form>
        )}
      </div>
    </div>
  );
}
