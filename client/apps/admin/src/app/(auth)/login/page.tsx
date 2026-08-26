"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { buttonClassName } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const passwordReset = searchParams.get("passwordReset");
  const passwordChanged = searchParams.get("passwordChanged");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/core/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
        credentials: "include",
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(
          res.status === 503 || data.code === "CORE_BACKEND_UNAVAILABLE"
            ? "The core service is starting or unavailable. Please try again shortly."
            : typeof data.error === "string"
              ? data.error
              : "Invalid email or password"
        );
        return;
      }

      router.push("/dashboard");
    } catch {
      setError("Unable to sign in right now");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="rounded-[calc(var(--radius)-1px)] border border-line bg-card p-6 shadow-pop sm:p-8">
        <div className="mb-8 text-center">
          <div aria-hidden="true" className="mx-auto mb-4 grid size-12 place-items-center rounded-md bg-primary text-lg font-bold text-primary-foreground shadow-glow">K</div>
          <h1 className="text-2xl font-semibold tracking-[-0.025em] text-foreground">Kasitek Labs</h1>
          <p className="mt-1 text-sm text-muted-foreground">Sign in to the internal operations workspace.</p>
        </div>

        {passwordReset === "success" ? (
          <div className="mb-4 rounded-md border border-status-success/25 bg-status-success-soft px-4 py-3 text-sm text-status-success">
            Your password has been reset. Sign in with the new password.
          </div>
        ) : null}

        {passwordChanged === "success" ? (
          <div className="mb-4 rounded-md border border-status-success/25 bg-status-success-soft px-4 py-3 text-sm text-status-success">
            Your password has been updated.
          </div>
        ) : null}

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-md border border-status-danger/25 bg-status-danger-soft px-4 py-3 text-sm text-status-danger">
              {error}
            </div>
          )}

          <div>
              <label htmlFor="email" className="mb-1 block text-sm font-medium text-foreground">
              Email
            </label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between gap-3">
              <label htmlFor="password" className="block text-sm font-medium text-foreground">
                Password
              </label>
              <Link
                href="/forgot-password"
                className="text-sm font-medium text-foreground underline-offset-4 hover:underline"
              >
                Forgot password?
              </Link>
            </div>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="pr-14"
              />
              <button
                type="button"
                onClick={() => setShowPassword((current) => !current)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className={buttonClassName({ className: "w-full" })}
          >
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return <Suspense fallback={<div className="text-sm text-muted-foreground">Loading sign in...</div>}><LoginContent /></Suspense>;
}
