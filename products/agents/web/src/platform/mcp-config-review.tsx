import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";

type Review = { id: string; agentName: string; state: "pending" | "approved" | "cancelled" | "expired"; changes: { field: string; before: string; after: string }[] };

export function McpConfigReview() {
  const [parameters] = useSearchParams();
  const request = parameters.get("request");
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!request) { setError("This request is unavailable."); return; }
    const controller = new AbortController();
    void fetch(`/api/mcp/config-reviews/${encodeURIComponent(request)}`, { credentials: "same-origin", signal: controller.signal }).then(async response => {
      if (response.status === 401) { window.location.assign(`/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`); return; }
      if (!response.ok) throw new Error("This request is unavailable or has expired.");
      setReview(await response.json() as Review);
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load request."); });
    return () => controller.abort();
  }, [request]);
  async function decide(approved: boolean) {
    if (!request || busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/mcp/config-reviews/${encodeURIComponent(request)}/decision`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved }) });
      if (!response.ok) throw new Error("The request could not be completed. It may have expired or the agent may have changed.");
      setReview(await response.json() as Review);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not complete request."); }
    finally { setBusy(false); }
  }
  return <main className="dashboard-theme min-h-dvh bg-background px-6 py-16 text-foreground"><section className="mx-auto max-w-2xl space-y-6 rounded-xl border border-border bg-card p-6">
    <h1 className="text-xl font-semibold">Review agent changes</h1>
    {!review && !error && <p role="status">Loading request…</p>}
    {review && <><p>Agent: <strong>{review.agentName}</strong></p>
      {review.changes.map((change, index) => <section key={`${change.field}-${index}`} className="space-y-2 border-t border-border pt-4"><h2 className="font-medium">{change.field}</h2><div className="grid gap-3 sm:grid-cols-2"><div><p className="text-sm text-muted-foreground">Current</p><p className="whitespace-pre-wrap break-words text-sm">{change.before}</p></div><div><p className="text-sm text-muted-foreground">Proposed</p><p className="whitespace-pre-wrap break-words text-sm">{change.after}</p></div></div></section>)}
      {review.state === "pending" ? <div className="flex gap-3"><Button disabled={busy} onClick={() => void decide(true)}>{busy ? "Processing…" : "Apply changes"}</Button><Button variant="outline" disabled={busy} onClick={() => void decide(false)}>Cancel</Button></div> : <p role="status">{review.state === "approved" ? "Changes applied" : review.state === "cancelled" ? "Request cancelled" : "Request expired"}</p>}
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section></main>;
}
