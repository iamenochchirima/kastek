"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Eye, EyeOff } from "lucide-react";
import { apiUrl } from "@/lib/server-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function LoginForm() {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? undefined;
  const verified = searchParams.get("verified") ?? undefined;
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [isGoogleOnly, setIsGoogleOnly] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleGoogleSignIn = () => {
    window.location.assign(
      apiUrl(`/api/auth/google/start?callbackUrl=${encodeURIComponent(callbackUrl ?? "/workspace")}`),
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsGoogleOnly(false);
    setLoading(true);

    try {
      const response = await fetch(apiUrl("/api/auth/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
      };

      if (!response.ok) {
        if (payload.code === "EMAIL_UNVERIFIED") {
          router.replace(`/verify-request?email=${encodeURIComponent(email)}`);
          return;
        }

        // A failed account check should not hide the original login error.
        const check = await fetch(apiUrl("/api/auth/account-check"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ email }),
        }).catch(() => null);
        const account = check?.ok
          ? ((await check.json().catch(() => ({}))) as { provider?: string })
          : {};

        if (account.provider === "google") {
          setIsGoogleOnly(true);
          setError(
            "This account uses Google sign-in. Use the Google button above, or set up a password.",
          );
        } else {
          setError(payload.error || "Invalid email or password");
        }
      } else {
        router.refresh();
        router.push(callbackUrl ?? "/workspace");
      }
    } catch {
      setError("We could not reach KasiTek. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {verified && (
        <div className="rounded-xl border border-status-success/30 bg-status-success-soft px-4 py-3 text-center text-sm text-status-success">
          Email verified successfully. You can now sign in.
        </div>
      )}

      {error && (
        <div
          role="alert"
          aria-live="polite"
          className="rounded-lg border border-destructive/30 bg-status-danger-soft px-4 py-3 text-center text-sm text-destructive"
        >
          {error}
          {isGoogleOnly && (
            <p className="mt-2 text-xs text-muted-foreground">
              Want to use email and password instead?{" "}
              <Link href="/set-password" className="text-primary hover:underline">
                Set up a password
              </Link>
            </p>
          )}
        </div>
      )}

      <Button
        onClick={handleGoogleSignIn}
        className="w-full"
        variant="outline"
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
      </Button>

      <div className="flex items-center gap-4">
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">or</span>
        <div className="h-px flex-1 bg-border" />
      </div>

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
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">
            Password
          </label>
          <div className="relative">
            <Input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              required
              className="h-10 pr-11"
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
        </div>
        <Button
          type="submit"
          disabled={loading}
          className="w-full"
        >
          {loading ? "Signing in..." : "Sign In"}
        </Button>
      </form>

      {process.env.NEXT_PUBLIC_KASITEK_ACCESS_MODE === "public" && (
        <p className="text-center text-sm text-muted-foreground">
          Don&apos;t have an account? <Link href="/signup" className="text-primary hover:underline">Sign up</Link>
        </p>
      )}
    </div>
  );
}
