"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function OnboardingForm() {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [phoneVerified, setPhoneVerified] = useState(false);
  const [otpLoading, setOtpLoading] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

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

    setLoading(true);

    const res = await fetch("/api/onboarding/phone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, phoneVerified: true }),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.error);
    } else {
      router.push("/dashboard");
    }
  };

  return (
    <form onSubmit={handleSubmit} className="max-w-md space-y-4">
      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <div>
        <label className="mb-1.5 block text-sm font-medium text-text">
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
            className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text placeholder:text-text-dim focus:border-accent focus:outline-none disabled:opacity-60"
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
              className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
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
            className="mt-1.5 text-xs text-text-dim hover:text-accent"
          >
            Resend code
          </button>
        )}
        <p className="mt-1.5 text-xs text-text-dim">
          We&apos;ll use this to keep you updated about your bots and account.
        </p>
      </div>

      <button
        type="submit"
        disabled={loading || !phoneVerified}
        className="rounded-full bg-accent px-8 py-3 text-sm font-semibold text-bg transition-all hover:-translate-y-0.5 hover:shadow-[0_4px_20px_rgba(196,240,77,0.25)] disabled:opacity-50 disabled:hover:translate-y-0"
      >
        {loading ? "Saving..." : "Continue"}
      </button>
    </form>
  );
}
