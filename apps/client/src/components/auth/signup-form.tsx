"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";
import Link from "next/link";

export default function SignupForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [phoneVerified, setPhoneVerified] = useState(false);
  const [otpLoading, setOtpLoading] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [passwordSetupSent, setPasswordSetupSent] = useState(false);

  const handleGoogleSignIn = () => {
    signIn("google", { callbackUrl: "/dashboard" });
  };

  const handleSendOtp = async () => {
    if (!phone) {
      setError("Please enter a phone number");
      return;
    }
    setError("");
    setOtpLoading(true);

    const res = await fetch("/api/auth/send-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    });

    const data = await res.json();
    setOtpLoading(false);

    if (!res.ok) {
      setError(data.error);
    } else {
      setOtpSent(true);
    }
  };

  const handleVerifyOtp = async () => {
    if (!otp) {
      setError("Please enter the verification code");
      return;
    }
    setError("");
    setOtpLoading(true);

    const res = await fetch("/api/auth/verify-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, code: otp }),
    });

    const data = await res.json();
    setOtpLoading(false);

    if (!res.ok) {
      setError(data.error);
    } else {
      setPhoneVerified(true);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!phoneVerified) {
      setError("Please verify your phone number first");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setLoading(true);

    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name, phone, phoneVerified: true }),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      if (data.code === "GOOGLE_ACCOUNT_EXISTS") {
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
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-accent/15 bg-accent-glow text-2xl">
          ✉️
        </div>
        <h2 className="font-serif text-2xl text-foreground">Check your email</h2>
        <p className="text-muted-foreground">
          We sent a verification link to <strong className="text-foreground">{email}</strong>.
          Click the link to activate your account.
        </p>
        <Link
          href="/login"
          className="inline-block text-sm text-accent hover:underline"
        >
          Back to Sign In
        </Link>
      </div>
    );
  }

  if (passwordSetupSent) {
    return (
      <div className="space-y-4 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-accent/15 bg-accent-glow text-2xl">
          ✉️
        </div>
        <h2 className="font-serif text-2xl text-foreground">Google account found</h2>
        <p className="text-muted-foreground">
          You already have an account linked to Google. We sent a link to{" "}
          <strong className="text-foreground">{email}</strong> to set up a password so
          you can sign in with either method.
        </p>
        <Link
          href="/login"
          className="inline-block text-sm text-accent hover:underline"
        >
          Back to Sign In
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-center text-sm text-red-400">
          {error}
        </div>
      )}

      <button
        onClick={handleGoogleSignIn}
        className="flex w-full items-center justify-center gap-3 rounded-full border border-border bg-card px-6 py-3 text-sm font-semibold text-foreground transition-all hover:border-primary/20 hover:bg-secondary/30"
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
            className="w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
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
            className="w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">
            Phone Number
          </label>
          <div className="flex gap-2">
            <input
              type="tel"
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value);
                if (phoneVerified) {
                  setPhoneVerified(false);
                  setOtpSent(false);
                  setOtp("");
                }
              }}
              placeholder="e.g. +27 72 123 4567"
              required
              disabled={phoneVerified}
              className="w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none disabled:opacity-60"
            />
            {!phoneVerified && !otpSent && (
              <button
                type="button"
                onClick={handleSendOtp}
                disabled={otpLoading || !phone}
                className="shrink-0 rounded-xl border border-accent bg-accent/10 px-4 py-3 text-sm font-medium text-accent transition-colors hover:bg-accent/20 disabled:opacity-50"
              >
                {otpLoading ? "Sending..." : "Send Code"}
              </button>
            )}
            {phoneVerified && (
              <div className="flex shrink-0 items-center rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm font-medium text-accent">
                Verified
              </div>
            )}
          </div>
          {otpSent && !phoneVerified && (
            <div className="mt-2 flex gap-2">
              <input
                type="text"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="Enter 6-digit code"
                maxLength={6}
                className="w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
              />
              <button
                type="button"
                onClick={handleVerifyOtp}
                disabled={otpLoading || otp.length < 6}
                className="shrink-0 rounded-xl border border-accent bg-accent/10 px-4 py-3 text-sm font-medium text-accent transition-colors hover:bg-accent/20 disabled:opacity-50"
              >
                {otpLoading ? "Checking..." : "Verify"}
              </button>
            </div>
          )}
          {otpSent && !phoneVerified && (
            <button
              type="button"
              onClick={handleSendOtp}
              disabled={otpLoading}
              className="mt-1.5 text-xs text-muted-foreground hover:text-primary"
            >
              Resend code
            </button>
          )}
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter a unique password"
            required
            minLength={8}
            className="w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">
            Confirm Password
          </label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Confirm your password"
            required
            minLength={8}
            className="w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
          />
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
