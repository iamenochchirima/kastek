import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";

type Review = { id: string; agentId: string; agentName: string; allowedOrigins: string[]; instructions: string; appearance: { title: string; greeting: string; accent: string; launcherLabel: string; position: string }; sources: { title: string; visibility: string; state: string }[]; state: "pending" | "approved" | "cancelled" | "expired"; deploymentId: string | null };

export function McpWebsiteReview() {
  const [parameters] = useSearchParams();
  const request = parameters.get("request");
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!request) { setError("This request is unavailable."); return; }
    const controller = new AbortController();
    void fetch(`/api/mcp/website-reviews/${encodeURIComponent(request)}`, { credentials: "same-origin", signal: controller.signal }).then(async response => {
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
      const response = await fetch(`/api/mcp/website-reviews/${encodeURIComponent(request)}/decision`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved }) });
      if (!response.ok) throw new Error("The request could not be completed. It may have expired or the agent may have changed.");
      setReview(await response.json() as Review);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not complete request."); }
    finally { setBusy(false); }
  }

  return <main className="dashboard-theme min-h-dvh bg-background px-6 py-16 text-foreground"><section className="mx-auto max-w-lg space-y-6 rounded-xl border border-border bg-card p-6">
    <h1 className="text-xl font-semibold">Review website activation</h1>
    {!review && !error && <p role="status">Loading request…</p>}
    {review && <><p>Agent: <Link className="underline" to={`/app/agents/${encodeURIComponent(review.agentId)}`}>{review.agentName}</Link></p>
      <div><h2 className="text-sm font-medium">Instructions</h2><p className="mt-2 whitespace-pre-wrap break-words text-sm">{review.instructions}</p></div>
      <div><h2 className="text-sm font-medium">Widget</h2><p className="mt-2 text-sm">{review.appearance.title} · {review.appearance.accent} · {review.appearance.position}</p><p className="mt-1 text-sm">{review.appearance.greeting}</p><p className="mt-1 text-sm">Button: {review.appearance.launcherLabel}</p></div>
      <div><h2 className="text-sm font-medium">Knowledge</h2>{review.sources.length ? <ul className="mt-2 list-inside list-disc text-sm">{review.sources.map((source, index) => <li key={`${source.title}-${index}`}>{source.title} ({source.visibility}, {source.state})</li>)}</ul> : <p className="mt-2 text-sm text-muted-foreground">No sources</p>}</div>
      <div><h2 className="text-sm font-medium">Allowed websites</h2><ul className="mt-2 list-inside list-disc break-all text-sm">{review.allowedOrigins.map(origin => <li key={origin}>{origin}</li>)}</ul></div>
      {review.state === "pending" ? <div className="flex gap-3"><Button disabled={busy} onClick={() => void decide(true)}>{busy ? "Processing…" : "Activate"}</Button><Button variant="outline" disabled={busy} onClick={() => void decide(false)}>Cancel</Button></div> : <p role="status">{review.state === "approved" ? "Website activated" : review.state === "cancelled" ? "Request cancelled" : "Request expired"}</p>}
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section></main>;
}
