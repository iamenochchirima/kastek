import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError, message, type Session } from "./api";

type TransferPreview = {
  agentName: string;
  agentVersion: number;
  organizationName: string;
  organizationId: string;
  email: string;
  state: "pending" | "accepted" | "declined" | "cancelled" | "expired";
  expiresAt: string;
  sources: { title: string; revision: number }[];
  targetOrganizationId: string | null;
  createdAgentId: string | null;
};

const dateLabel = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
};

export function TransferPage() {
  const { token = "" } = useParams();
  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [organizationId, setOrganizationId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setPreview(null); setError(""); setSignedIn(null);
    void api<{ transfer: TransferPreview }>(`/api/agent-transfers/${encodeURIComponent(token)}`)
      .then(result => { if (live) setPreview(result.transfer); })
      .catch(cause => { if (live) setError(message(cause)); });
    void api<Session>("/api/session")
      .then(result => {
        if (!live) return;
        setSession(result); setSignedIn(true);
      })
      .catch(cause => {
        if (!live) return;
        setSignedIn(false);
        if (!(cause instanceof ApiError) || cause.status !== 401) setError(message(cause));
      });
    return () => { live = false; };
  }, [token]);

  useEffect(() => {
    if (!preview || !session) return;
    const destinations = session.organizations.filter(organization => organization.id !== preview.organizationId && ["owner", "admin"].includes(organization.role));
    if (!destinations.some(organization => organization.id === organizationId)) setOrganizationId(destinations[0]?.id ?? "");
  }, [organizationId, preview, session]);

  async function accept() {
    if (!organizationId) return;
    setBusy(true); setError("");
    try {
      const result = await api<{ agentId: string; organizationId: string }>(`/api/agent-transfers/${encodeURIComponent(token)}/accept`, { organizationId }, "POST");
      sessionStorage.setItem("agents.organization", result.organizationId);
      window.location.assign(`/app/agents/${result.agentId}`);
    } catch (cause) {
      setError(cause instanceof ApiError && cause.code === "TRANSFER_EMAIL_MISMATCH"
        ? "Sign in with the email address that received this transfer."
        : message(cause));
    } finally { setBusy(false); }
  }

  async function decline() {
    setBusy(true); setError("");
    try {
      await api(`/api/agent-transfers/${encodeURIComponent(token)}/decline`, {}, "POST");
      setPreview(current => current ? { ...current, state: "declined" } : current);
      toast.success("Transfer declined");
    } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }

  const signIn = () => window.location.assign(`/login?returnTo=${encodeURIComponent(`/transfer/${token}`)}`);
  const destinations = session?.organizations.filter(organization => organization.id !== preview?.organizationId && ["owner", "admin"].includes(organization.role)) ?? [];
  const openAgent = () => {
    if (!preview?.createdAgentId) return;
    sessionStorage.setItem("agents.organization", preview.targetOrganizationId ?? "");
    window.location.assign(`/app/agents/${preview.createdAgentId}`);
  };

  return (
    <main className="dashboard-theme min-h-dvh bg-background px-6 py-16 text-foreground">
      <section className="mx-auto w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-panel)]">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">KasiTek Agents</p>
        {error && !preview ? <><h1 className="mt-2 text-xl font-semibold">Transfer unavailable</h1><p className="mt-2 text-sm text-muted-foreground">{error}</p></> : !preview ? <div className="mt-4 space-y-3" aria-label="Loading transfer"><Skeleton className="h-6 w-48" /><Skeleton className="h-4 w-full" /><Skeleton className="h-10 w-32" /></div> : <>
          <h1 className="mt-2 text-xl font-semibold">{preview.agentName}</h1>
          <p className="mt-1 text-sm text-muted-foreground">From {preview.organizationName} · version {preview.agentVersion}</p>
          <p className="mt-2 text-sm text-muted-foreground">For <span className="font-medium text-foreground">{preview.email}</span></p>
          <p className="mt-1 text-xs text-muted-foreground">Expires {dateLabel(preview.expiresAt)}</p>

          {preview.sources.length ? <div className="mt-5 rounded-md border border-border p-3"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Knowledge</p><ul className="mt-2 space-y-1 text-sm">{preview.sources.map(source => <li key={`${source.title}-${source.revision}`}>{source.title}</li>)}</ul></div> : null}
          <p className="mt-4 text-xs text-muted-foreground">Model connections, channels, domains, conversations and version history do not move.</p>

          {error ? <p role="alert" className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p> : null}

          {preview.state === "pending" ? (
            signedIn === null ? <Skeleton className="mt-6 h-10 w-40" /> :
            signedIn ? destinations.length ? <div className="mt-6 space-y-4">
              <div className="space-y-2"><p className="text-sm font-medium">Destination workspace</p>{destinations.map(organization => <label key={organization.id} className="flex items-center gap-3 rounded-md border border-border p-3 text-sm"><input type="radio" name="destination" value={organization.id} checked={organizationId === organization.id} disabled={busy} onChange={() => setOrganizationId(organization.id)} /><span>{organization.name}</span><span className="ml-auto text-xs text-muted-foreground">{organization.role === "owner" ? "Owner" : "Admin"}</span></label>)}</div>
              <div className="flex flex-wrap gap-2"><Button disabled={busy || !organizationId} onClick={() => void accept()}>{busy ? "Accepting…" : "Accept transfer"}</Button><Button variant="outline" disabled={busy} onClick={() => void decline()}>Decline</Button></div>
            </div> : <div className="mt-6 space-y-3"><p className="text-sm text-muted-foreground">You need a workspace you own or administer.</p><Button variant="outline" onClick={() => window.location.assign("/app/overview")}>Open Agents</Button><Button variant="ghost" disabled={busy} onClick={() => void decline()}>Decline transfer</Button></div> :
            <div className="mt-6 space-y-3"><Button onClick={signIn}>Sign in to accept</Button><p className="text-xs text-muted-foreground">Use the account with the email address that received this transfer.</p></div>
          ) : preview.state === "accepted" ? (
            <div className="mt-6 space-y-3"><p className="text-sm">This transfer was accepted.</p>{preview.createdAgentId ? <Button onClick={openAgent}>Open agent</Button> : null}</div>
          ) : preview.state === "declined" ? (
            <p className="mt-6 text-sm text-muted-foreground">This transfer was declined.</p>
          ) : preview.state === "cancelled" ? (
            <p className="mt-6 text-sm text-muted-foreground">This transfer was cancelled.</p>
          ) : (
            <p className="mt-6 text-sm text-muted-foreground">This transfer has expired. Ask the sender for a new one.</p>
          )}
        </>}
      </section>
    </main>
  );
}
