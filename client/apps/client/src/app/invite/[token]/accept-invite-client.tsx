"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { CheckCircle, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiUrl } from "@/lib/server-api";
import type { InvitationPreview } from "@/lib/orgs";

const ROLE_LABELS: Record<string, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MEMBER: "Member",
};

export function AcceptInviteClient({
  token,
  invitation,
  isLoggedIn,
}: {
  token: string;
  invitation: InvitationPreview | null;
  isLoggedIn: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  if (!invitation) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="w-full max-w-md space-y-4 rounded-2xl border border-border bg-card p-8 text-center">
          <XCircle className="mx-auto h-12 w-12 text-destructive" />
          <h1 className="text-xl font-semibold text-foreground">Invitation not found</h1>
          <p className="text-sm text-muted-foreground">
            This invitation link is invalid or has expired.
          </p>
          <Button onClick={() => router.push("/workspace")} className="w-full">
            Go to workspace
          </Button>
        </div>
      </div>
    );
  }

  if (invitation.acceptedAt) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="w-full max-w-md space-y-4 rounded-2xl border border-border bg-card p-8 text-center">
          <CheckCircle className="mx-auto h-12 w-12 text-status-success" />
          <h1 className="text-xl font-semibold text-foreground">Already accepted</h1>
          <p className="text-sm text-muted-foreground">
            This invitation has already been accepted.
          </p>
          <Button onClick={() => router.push("/workspace")} className="w-full">
            Go to workspace
          </Button>
        </div>
      </div>
    );
  }

  const isExpired = new Date(invitation.expiresAt) < new Date();

  if (isExpired) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="w-full max-w-md space-y-4 rounded-2xl border border-border bg-card p-8 text-center">
          <XCircle className="mx-auto h-12 w-12 text-destructive" />
          <h1 className="text-xl font-semibold text-foreground">Invitation expired</h1>
          <p className="text-sm text-muted-foreground">
            This invitation expired on{" "}
            {new Date(invitation.expiresAt).toLocaleDateString()}. Ask an admin to
            send a new one.
          </p>
          <Button onClick={() => router.push("/workspace")} className="w-full">
            Go to workspace
          </Button>
        </div>
      </div>
    );
  }

  async function handleAccept() {
    if (!isLoggedIn) {
      router.push(`/login?callbackUrl=${encodeURIComponent(`/invite/${token}`)}`);
      return;
    }

    setLoading(true);
    setError(null);

    const res = await fetch(apiUrl(`/api/invitations/${token}/accept`), {
      method: "POST",
      credentials: "include",
    });

    setLoading(false);

    if (res.ok) {
      setAccepted(true);
      setTimeout(() => {
        router.push("/workspace");
        router.refresh();
      }, 1500);
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to accept invitation");
    }
  }

  async function handleActivation(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    setError(null);
    const res = await fetch(apiUrl(`/api/invitations/${token}/activate`), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, password }),
    });
    setLoading(false);

    if (res.ok) {
      setAccepted(true);
      setTimeout(() => {
        router.push("/workspace");
        router.refresh();
      }, 1200);
      return;
    }

    const data = await res.json().catch(() => ({}));
    setError(data.error ?? "We could not activate this invitation.");
  }

  if (accepted) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="w-full max-w-md space-y-4 rounded-2xl border border-border bg-card p-8 text-center">
          <CheckCircle className="mx-auto h-12 w-12 text-status-success" />
          <h1 className="text-xl font-semibold text-foreground">Welcome to {invitation.orgName}!</h1>
          <p className="text-sm text-muted-foreground">Redirecting to workspace…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-6 rounded-2xl border border-border bg-card p-8">
        {/* Org info */}
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-border bg-secondary/40 text-lg font-bold text-primary">
            {invitation.orgLogo ? (
              <Image unoptimized width={56} height={56} src={invitation.orgLogo} alt={invitation.orgName} className="h-full w-full rounded-xl object-cover" />
            ) : (
              invitation.orgName[0]?.toUpperCase()
            )}
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              Invitation
            </p>
            <p className="text-xl font-semibold text-foreground">{invitation.orgName}</p>
          </div>
        </div>

        {/* Details */}
        <div className="rounded-xl border border-border bg-secondary/35 p-4 space-y-3 text-sm">
          {invitation.invitedByName ? (
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Invited by</span>
              <span className="font-medium text-foreground">{invitation.invitedByName}</span>
            </div>
          ) : null}
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">Role</span>
            <span className="font-medium text-foreground">
              {ROLE_LABELS[invitation.role] ?? invitation.role}
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">Sent to</span>
            <span className="font-medium text-foreground">{invitation.email}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">Expires</span>
            <span className="font-medium text-foreground">
              {new Date(invitation.expiresAt).toLocaleDateString()}
            </span>
          </div>
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        {isLoggedIn ? (
          <Button onClick={handleAccept} disabled={loading} className="w-full" size="lg">
            {loading ? "Joining…" : `Join ${invitation.orgName}`}
          </Button>
        ) : (
          <form onSubmit={handleActivation} className="space-y-3">
            <p className="text-sm text-muted-foreground">Create your account to join this workspace.</p>
            <label className="block text-sm font-medium text-foreground">Name
              <Input value={name} onChange={(event) => setName(event.target.value)} required className="mt-1.5" placeholder="Your name" />
            </label>
            <label className="block text-sm font-medium text-foreground">Password
              <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} className="mt-1.5" placeholder="At least 8 characters" />
            </label>
            <label className="block text-sm font-medium text-foreground">Confirm password
              <Input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required minLength={8} className="mt-1.5" placeholder="Confirm your password" />
            </label>
            <Button type="submit" disabled={loading} className="w-full" size="lg">{loading ? "Creating account…" : "Create account and join"}</Button>
            <p className="text-center text-xs text-muted-foreground">Already have an account? <button type="button" onClick={() => router.push(`/login?callbackUrl=${encodeURIComponent(`/invite/${token}`)}`)} className="text-primary hover:underline">Sign in</button></p>
          </form>
        )}

        <p className="text-center text-xs text-muted-foreground">
          By joining, you agree to work within this organisation&apos;s workspace on KasiTek.
        </p>
      </div>
    </div>
  );
}
