import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { api, message, writeStored } from "./api";

// Keep a one-use link only in memory while React mounts and removes the URL fragment.
const pendingSecrets = new Map<string, string>();
export function CustomerReturn() {
  const { deploymentId = "" } = useParams(); const navigate = useNavigate();
  const fragment = window.location.hash.slice(1);
  if (/^[A-Za-z0-9_-]{43}$/.test(fragment)) pendingSecrets.set(deploymentId, fragment);
  const secret = useRef(pendingSecrets.get(deploymentId) ?? "");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search); }, []);
  async function open() {
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret.current)) { setError("This link is invalid or has expired."); return; }
    setBusy(true); setError("");
    try {
      const path = `/api/website/${encodeURIComponent(deploymentId)}`;
      const session = await api<{token:string}>(`${path}/session`, {});
      await api(`${path}/followup/return`, {secret:secret.current}, "POST", session.token);
      secret.current = ""; pendingSecrets.delete(deploymentId); writeStored(`agents.visitor.${deploymentId}`, session.token);
      navigate(`/chat/${encodeURIComponent(deploymentId)}`, { replace:true });
    } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }
  return <main className="dashboard-theme min-h-dvh bg-background px-6 py-16 text-foreground"><section className="mx-auto max-w-md space-y-4"><h1 className="text-xl font-semibold">Return to support</h1><p className="text-sm text-muted-foreground">This link expires after 30 minutes and can be used once.</p>{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}<Button disabled={busy} onClick={() => void open()}>{busy ? "Opening…" : "Open conversation"}</Button></section></main>;
}
