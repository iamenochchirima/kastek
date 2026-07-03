"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

export default function ResetPasswordPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const email = searchParams.get("email") ?? "";
  const token = searchParams.get("token") ?? "";
  const hasValidParams = email.length > 0 && token.length > 0;

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    if (!hasValidParams) {
      setError("This reset link is incomplete. Request a new password reset email.");
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/core/admin/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, token, password }),
      });

      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Unable to reset password");
        return;
      }

      router.push("/login?passwordReset=success");
    } catch {
      setError("Unable to reset password");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <div className="rounded-xl border border-border bg-surface-raised p-8">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-text">Choose a new password</h1>
          <p className="mt-1 text-sm text-text-muted">
            Set a new password for your KasiTek admin account.
          </p>
        </div>

        {!hasValidParams ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
              This reset link is invalid. Request a new password reset email.
            </div>
            <Link
              href="/forgot-password"
              className="block text-sm text-primary hover:text-primary-dark"
            >
              Request a new reset link
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
              <label htmlFor="password" className="mb-1 block text-sm font-medium text-text-muted">
                New password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={8}
                required
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-text focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>

            <div>
              <label
                htmlFor="confirmPassword"
                className="mb-1 block text-sm font-medium text-text-muted"
              >
                Confirm password
              </label>
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                minLength={8}
                required
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-text focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-primary py-2.5 font-medium text-white transition-colors hover:bg-primary-dark disabled:opacity-50"
            >
              {loading ? "Resetting..." : "Reset password"}
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
