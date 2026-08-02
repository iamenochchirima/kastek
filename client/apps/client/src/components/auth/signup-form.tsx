"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { apiUrl } from "@/lib/server-api";

function getPasswordStrength(password: string) {
  if (!password) return { score: 0, label: "", hint: "Use at least 8 characters." };

  const checks = [
    password.length >= 8,
    /[a-z]/.test(password) && /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
    password.length >= 12,
  ];
  const score = checks.filter(Boolean).length;

  if (score <= 1) return { score: 1, label: "Weak", hint: "Add uppercase, numbers, or symbols." };
  if (score === 2) return { score: 2, label: "Fair", hint: "Add another character type or make it longer." };
  if (score === 3) return { score: 3, label: "Good", hint: "A longer password will make it stronger." };
  return { score: 4, label: "Strong", hint: "This password has a good mix of characters." };
}

export default function SignupForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [passwordSetupSent, setPasswordSetupSent] = useState(false);
  const passwordStrength = getPasswordStrength(password);

  if (process.env.NEXT_PUBLIC_KASITEK_ACCESS_MODE !== "public") {
    return (
      <div className="space-y-4 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-2xl text-primary">✉️</div>
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">KasiTek is currently invite-only</h2>
        <p className="text-muted-foreground">Use the secure link sent by your workspace administrator to create your account. Once activated, you can always sign in normally.</p>
        <Link href="/login" className="inline-block text-sm text-primary hover:underline">Already have an account? Sign in</Link>
      </div>
    );
  }

  const handleGoogleSignIn = () => {
    window.location.assign(
      apiUrl(`/api/auth/google/start?callbackUrl=${encodeURIComponent("/workspace")}`),
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setLoading(true);

    const res = await fetch(apiUrl("/api/auth/signup"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        email,
        password,
        name,
      }),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      if (data.code === "EMAIL_UNVERIFIED") {
        router.replace(`/verify-request?email=${encodeURIComponent(email)}`);
      } else if (data.code === "GOOGLE_ACCOUNT_EXISTS") {
        setPasswordSetupSent(true);
      } else {
        setError(data.error);
      }
    } else {
      setSuccess(true);
    }
  };

  if (success) {
    return (
      <div className="space-y-4 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-2xl text-primary">
          ✉️
        </div>
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">Check your email</h2>
        <p className="text-muted-foreground">
          We sent a verification link to <strong className="text-foreground">{email}</strong>.
          Click the link to activate your account.
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

  if (passwordSetupSent) {
    return (
      <div className="space-y-4 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-2xl text-primary">
          ✉️
        </div>
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">Google account found</h2>
        <p className="text-muted-foreground">
          You already have an account linked to Google. We sent a link to{" "}
          <strong className="text-foreground">{email}</strong> to set up a password so
          you can sign in with either method.
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

      <button
        onClick={handleGoogleSignIn}
        className="flex w-full items-center justify-center gap-3 rounded-full border border-border bg-secondary px-6 py-3 text-sm font-semibold text-foreground transition-all hover:border-primary/20 hover:bg-secondary/80"
      >
        <svg className="h-5 w-5" viewBox="0 0 24 24">
          <path
            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
            fill="#4285F4"
          />
          <path
            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            fill="#34A853"
          />
          <path
            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            fill="#FBBC05"
          />
          <path
            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            fill="#EA4335"
          />
        </svg>
        Continue with Google
      </button>

      <div className="flex items-center gap-4">
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">or</span>
        <div className="h-px flex-1 bg-border" />
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            className="w-full rounded-xl border border-border bg-secondary px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">
            Email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="your@email.com"
            required
            className="w-full rounded-xl border border-border bg-secondary px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">
            Password
          </label>
          <div className="relative">
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter a unique password"
              required
              minLength={8}
              className="w-full rounded-xl border border-border bg-card px-4 py-3 pr-11 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setShowPassword((visible) => !visible)}
              className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus:outline-none"
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <div className="mt-2" aria-live="polite">
            <div className="flex gap-1" aria-label={passwordStrength.label ? `Password strength: ${passwordStrength.label}` : "Password strength"}>
              {[1, 2, 3, 4].map((segment) => (
                <span
                  key={segment}
                  className={`h-1 flex-1 rounded-full ${
                    segment <= passwordStrength.score
                      ? passwordStrength.score === 1
                        ? "bg-destructive"
                        : passwordStrength.score === 2
                          ? "bg-status-attention"
                          : passwordStrength.score === 3
                            ? "bg-primary/70"
                            : "bg-primary"
                      : "bg-border"
                  }`}
                />
              ))}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {passwordStrength.label ? <span className="font-medium text-foreground">{passwordStrength.label}. </span> : null}
              {passwordStrength.hint}
            </p>
          </div>
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">
            Confirm Password
          </label>
          <div className="relative">
            <input
              type={showConfirmPassword ? "text" : "password"}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm your password"
              required
              minLength={8}
              className="w-full rounded-xl border border-border bg-card px-4 py-3 pr-11 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setShowConfirmPassword((visible) => !visible)}
              className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus:outline-none"
              aria-label={showConfirmPassword ? "Hide confirm password" : "Show confirm password"}
              aria-pressed={showConfirmPassword}
            >
              {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-full bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition-all hover:-translate-y-0.5 hover:bg-primary/90 disabled:opacity-50 disabled:hover:translate-y-0"
        >
          {loading ? "Creating account..." : "Continue"}
        </button>
      </form>

      <p className="text-center text-xs text-muted-foreground">
        By creating an account you agree to the Terms of Service and our Privacy
        Policy.
      </p>

      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href="/login" className="text-accent hover:underline">
          Log in
        </Link>
      </p>
    </div>
  );
}
