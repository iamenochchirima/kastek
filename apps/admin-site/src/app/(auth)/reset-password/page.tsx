"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { buttonClassName } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function ResetPasswordContent() {
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
      <div className="rounded-[calc(var(--radius)-1px)] border border-line bg-card p-6 shadow-pop sm:p-8">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-[-0.025em] text-foreground">Choose a new password</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Set a new password for your Kasitek Labs account.
          </p>
        </div>

        {!hasValidParams ? (
          <div className="space-y-4">
            <div className="rounded-md border border-status-danger/25 bg-status-danger-soft px-4 py-3 text-sm text-status-danger">
              This reset link is invalid. Request a new password reset email.
            </div>
            <Link
              href="/forgot-password"
              className="block text-sm text-primary hover:underline"
            >
              Request a new reset link
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
              <label htmlFor="password" className="mb-1 block text-sm font-medium text-foreground">
                New password
              </label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={8}
                required
              />
            </div>

            <div>
              <label
                htmlFor="confirmPassword"
                className="mb-1 block text-sm font-medium text-foreground"
              >
                Confirm password
              </label>
              <Input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                minLength={8}
                required
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className={buttonClassName({ className: "w-full" })}
            >
              {loading ? "Resetting..." : "Reset password"}
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

export default function ResetPasswordPage() {
  return <Suspense fallback={<div className="text-sm text-muted-foreground">Loading password reset...</div>}><ResetPasswordContent /></Suspense>;
}
