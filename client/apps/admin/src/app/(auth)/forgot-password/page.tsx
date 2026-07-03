"use client";

import Link from "next/link";
import { useState } from "react";

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
      <div className="rounded-xl border border-border bg-surface-raised p-8">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-text">Reset admin password</h1>
          <p className="mt-1 text-sm text-text-muted">
            Enter your admin email and we&apos;ll send a reset link if the account exists.
          </p>
        </div>

        {submitted ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-success/20 bg-success/10 px-4 py-3 text-sm text-success">
              If an admin account exists for that email, a reset link has been sent.
            </div>
            <Link href="/login" className="block text-sm text-primary hover:text-primary-dark">
              Back to sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {error ? (
              <div className="rounded-lg border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
                {error}
              </div>
            ) : null}

            <div>
              <label htmlFor="email" className="mb-1 block text-sm font-medium text-text-muted">
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-text focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-primary py-2.5 font-medium text-white transition-colors hover:bg-primary-dark disabled:opacity-50"
            >
              {loading ? "Sending..." : "Send reset link"}
            </button>

            <Link href="/login" className="block text-center text-sm text-primary hover:text-primary-dark">
              Back to sign in
            </Link>
          </form>
        )}
      </div>
    </div>
  );
}
