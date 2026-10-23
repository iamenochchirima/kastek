"use client";

import { useState } from "react";
import { AdminPageHeader } from "@/components/admin/page-header";
import { buttonClassName } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function LegacyPasswordSettings() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess("");

    if (nextPassword.length < 8) {
      setError("New password must be at least 8 characters");
      return;
    }

    if (nextPassword !== confirmPassword) {
      setError("New passwords do not match");
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/core/admin/password", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword,
          nextPassword,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };

      if (!res.ok) {
        setError(data.error ?? "Unable to update password");
        return;
      }

      setCurrentPassword("");
      setNextPassword("");
      setConfirmPassword("");
      setSuccess(data.message ?? "Password updated.");
    } catch {
      setError("Unable to update password");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="admin-page max-w-2xl">
      <AdminPageHeader title="Password" description="Update the password for your internal Kasitek Labs account." />

      <div className="v-card p-[var(--density-card-padding)]">
        <form onSubmit={handleSubmit} className="space-y-5">
          {error ? (
            <div className="rounded-md border border-status-danger/25 bg-status-danger-soft px-4 py-3 text-sm text-status-danger">
              {error}
            </div>
          ) : null}

          {success ? (
            <div className="rounded-md border border-status-success/25 bg-status-success-soft px-4 py-3 text-sm text-status-success">
              {success}
            </div>
          ) : null}

          <div>
            <label
              htmlFor="currentPassword"
              className="mb-1 block text-sm font-medium text-foreground"
            >
              Current password
            </label>
            <Input
              id="currentPassword"
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
            />
          </div>

          <div>
            <label
              htmlFor="nextPassword"
              className="mb-1 block text-sm font-medium text-foreground"
            >
              New password
            </label>
            <Input
              id="nextPassword"
              type="password"
              value={nextPassword}
              onChange={(event) => setNextPassword(event.target.value)}
              minLength={8}
              required
            />
          </div>

          <div>
            <label
              htmlFor="confirmPassword"
              className="mb-1 block text-sm font-medium text-foreground"
            >
              Confirm new password
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
            className={buttonClassName()}
          >
            {loading ? "Updating..." : "Update password"}
          </button>
        </form>
      </div>
    </div>
  );
}
