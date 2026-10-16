"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { CheckCircle, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { loginUrl } from "@/lib/shared-login";
import { apiUrl } from "@/lib/server-api";
import type { InvitationPreview } from "@/lib/orgs";
import { MotionReveal } from "@/components/ui/motion-reveal";

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

  if (!invitation) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background p-4">
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
      <div className="flex min-h-[100dvh] items-center justify-center bg-background p-4">
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
      <div className="flex min-h-[100dvh] items-center justify-center bg-background p-4">
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

    try {
      const res = await fetch(apiUrl(`/api/invitations/${encodeURIComponent(token)}/accept`), {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to accept invitation");
      }
      setAccepted(true);
      router.push("/workspace");
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to accept invitation");
    } finally {
      setLoading(false);
    }
  }

  if (accepted) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background p-4">
        <div className="w-full max-w-md space-y-4 rounded-2xl border border-border bg-card p-8 text-center">
          <CheckCircle className="mx-auto h-12 w-12 text-status-success" />
          <h1 className="text-xl font-semibold text-foreground">Welcome to {invitation.orgName}!</h1>
          <p className="text-sm text-muted-foreground">Redirecting to workspace…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background p-4">
      <MotionReveal>
      <div className="w-full max-w-md space-y-6 rounded-2xl border border-border bg-card p-6 shadow-[0_24px_80px_rgb(0_0_0_/_0.18)] sm:p-8">
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
          <div className="space-y-3">
            <Button asChild className="w-full" size="lg"><a href={loginUrl(`/invite/${encodeURIComponent(token)}`, true)}>Create account</a></Button>
            <Button asChild variant="outline" className="w-full"><a href={loginUrl(`/invite/${encodeURIComponent(token)}`)}>Sign in</a></Button>
          </div>
        )}

        <p className="text-center text-xs text-muted-foreground">
          By joining, you agree to work within this organisation&apos;s workspace on KasiTek.
        </p>
      </div>
      </MotionReveal>
    </div>
  );
}
