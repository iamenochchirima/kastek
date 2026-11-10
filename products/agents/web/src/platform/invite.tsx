import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError, message, type Session } from "./api";

type InvitationPreview = {
  organizationName: string;
  email: string;
  role: "owner" | "admin" | "member";
  expiresAt: string;
  state: "pending" | "accepted" | "revoked" | "expired";
};

const dateLabel = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
};

export function InvitePage() {
  const { token = "" } = useParams();
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setPreview(null);
    setError("");
    setSignedIn(null);
    void api<{ invitation: InvitationPreview }>(`/api/invitations/${encodeURIComponent(token)}`)
      .then((result) => { if (live) setPreview(result.invitation); })
      .catch((cause) => { if (live) setError(message(cause)); });
    void api<Session>("/api/session")
      .then(() => { if (live) setSignedIn(true); })
      .catch((cause) => {
        if (!live) return;
        setSignedIn(false);
        if (!(cause instanceof ApiError) || cause.status !== 401) setError(message(cause));
      });
    return () => { live = false; };
  }, [token]);

  async function accept() {
    setBusy(true);
    setError("");
    try {
      await api(`/api/invitations/${encodeURIComponent(token)}/accept`, {}, "POST");
      window.location.assign("/app/overview");
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.code === "INVITATION_EMAIL_MISMATCH"
          ? "Sign in with the email address that received this invitation."
          : message(cause),
      );
    } finally {
      setBusy(false);
    }
  }

  const signIn = () => window.location.assign(`/login?returnTo=${encodeURIComponent(`/invite/${token}`)}`);

  return (
    <main className="dashboard-theme min-h-dvh bg-background px-6 py-16 text-foreground">
      <section className="mx-auto w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-panel)]">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">KasiTek Agents</p>
        {error && !preview ? <><h1 className="mt-2 text-xl font-semibold">Invitation unavailable</h1><p className="mt-2 text-sm text-muted-foreground">{error}</p></> : !preview ? <div className="mt-4 space-y-3" aria-label="Loading invitation"><Skeleton className="h-6 w-48" /><Skeleton className="h-4 w-full" /><Skeleton className="h-10 w-32" /></div> : <>
          <h1 className="mt-2 text-xl font-semibold">Join {preview.organizationName}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Invitation for <span className="font-medium text-foreground">{preview.email}</span> as {preview.role === "owner" ? "an owner" : preview.role === "admin" ? "an admin" : "a member"}.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Expires {dateLabel(preview.expiresAt)}</p>

          {error ? <p role="alert" className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p> : null}

          {preview.state === "pending" ? (
            signedIn === null ? <Skeleton className="mt-6 h-10 w-40" /> :
            signedIn ? <Button className="mt-6" disabled={busy} onClick={() => void accept()}>{busy ? "Accepting…" : "Accept invitation"}</Button> :
            <div className="mt-6 space-y-3">
              <Button onClick={signIn}>Sign in to accept</Button>
              <p className="text-xs text-muted-foreground">Use the account with the invited email address.</p>
            </div>
          ) : preview.state === "accepted" ? (
            <div className="mt-6 space-y-3"><p className="text-sm">This invitation was already accepted.</p><Button variant="outline" onClick={() => window.location.assign("/app/overview")}>Open Agents</Button></div>
          ) : preview.state === "revoked" ? (
            <p className="mt-6 text-sm text-muted-foreground">This invitation was revoked. Ask the workspace owner for a new one.</p>
          ) : (
            <p className="mt-6 text-sm text-muted-foreground">This invitation has expired. Ask the workspace owner for a new one.</p>
          )}
        </>}
      </section>
    </main>
  );
}
