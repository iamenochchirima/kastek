"use client";

import { useState, use } from "react";
import Link from "next/link";
import { apiUrl } from "@/lib/server-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function SetPasswordForm({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; email?: string }>;
}) {
  const { token, email } = use(searchParams);
  const hasTokenAndEmail = !!token && !!email;

  if (hasTokenAndEmail) {
    return <PasswordSetupForm token={token} email={email} />;
  }

  return <RequestSetupForm />;
}

function RequestSetupForm() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const res = await fetch(apiUrl("/api/auth/request-password-setup"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email }),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.error);
    } else {
      setSent(true);
    }
  };

  if (sent) {
    return (
      <div className="space-y-4 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-2xl text-primary">
          ✉️
        </div>
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">Check your email</h2>
        <p className="text-muted-foreground">
          If a Google-linked account exists for{" "}
          <strong className="text-foreground">{email}</strong>, we sent a link to set
          up your password.
        </p>
        <Link
          href="/login"
          className="inline-block text-sm text-primary hover:underline"
        >
          Back to Sign In
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-status-danger-soft px-4 py-3 text-center text-sm text-destructive">
          {error}
        </div>
      )}

      <p className="text-center text-sm text-muted-foreground">
        Enter the email you used with Google and we&apos;ll send you a link to
        set up a password.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">
            Email
          </label>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="your@email.com"
            required
            className="h-10"
          />
        </div>
        <Button
          type="submit"
          disabled={loading}
          className="w-full"
        >
          {loading ? "Sending..." : "Send Setup Link"}
        </Button>
      </form>

      <p className="text-center text-sm text-muted-foreground">
        <Link href="/login" className="text-primary hover:underline">
          Back to Sign In
        </Link>
      </p>
    </div>
  );
}

function PasswordSetupForm({
  token,
  email,
}: {
  token: string;
  email: string;
}) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setLoading(true);

    const res = await fetch(apiUrl("/api/auth/set-password"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ token, email, password }),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.error);
    } else {
      setSuccess(true);
    }
  };

  if (success) {
    return (
      <div className="space-y-4 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-2xl text-primary">
          ✓
        </div>
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">Password Set</h2>
        <p className="text-muted-foreground">
          You can now sign in with your email and password, or continue using
          Google.
        </p>
        <Button asChild><Link href="/login">Sign in</Link></Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-status-danger-soft px-4 py-3 text-center text-sm text-destructive">
          {error}
        </div>
      )}

        <p className="text-center text-sm text-muted-foreground">
          Setting password for <strong className="text-foreground">{email}</strong>
        </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">
            Password
          </label>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter a password"
            required
            minLength={8}
            className="h-10"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">
            Confirm Password
          </label>
          <Input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Confirm your password"
            required
            minLength={8}
            className="h-10"
          />
        </div>
        <Button
          type="submit"
          disabled={loading}
          className="w-full"
        >
          {loading ? "Setting password..." : "Set Password"}
        </Button>
      </form>
    </div>
  );
}
