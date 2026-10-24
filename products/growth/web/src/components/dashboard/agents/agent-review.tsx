import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Check, LoaderCircle, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { growthAgents, getDraftDestinations, safeGrowthRoute, type GrowthAgentReview, type GrowthDraftDestination, type GrowthDraftProposal } from "@/lib/growth-agents";
import { useGrowthAgents } from "./agent-provider";

export function AgentDraftReview({ review }: { review: GrowthAgentReview }) {
  const agents = useGrowthAgents();
  const [replacement, setReplacement] = useState<GrowthAgentReview | null>(null);
  const current = replacement ?? review;
  const [now, setNow] = useState(() => Date.now());
  const [draft, setDraft] = useState<GrowthDraftProposal>(review.draft);
  const [destinations, setDestinations] = useState<GrowthDraftDestination[]>([]);
  const [destinationsLoaded, setDestinationsLoaded] = useState(false);
  const [editing, setEditing] = useState(!review.draft.channels.length);
  const [busy, setBusy] = useState(false);
  const [decisionSubmitted, setDecisionSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<{ fingerprint: string; id: string } | null>(null);
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); };
  }, []);
  useEffect(() => {
    if (current.state !== "proposed") return;
    const delay = Math.max(0, Date.parse(current.expiresAt) - Date.now());
    const timer = setTimeout(() => setNow(Date.now()), Math.min(delay + 50, 2147483647));
    return () => clearTimeout(timer);
  }, [current.state, current.expiresAt]);
  useEffect(() => {
    if (!editing && current.state !== "proposed") return;
    const abort = new AbortController();
    void getDraftDestinations(abort.signal).then((value) => { setDestinations(value.destinations); setDestinationsLoaded(true); }).catch((cause) => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to load destinations."); });
    return () => abort.abort();
  }, [editing, current.state]);
  const expired = Date.parse(current.expiresAt) <= now;
  const actionable = current.state === "proposed" && !expired && !decisionSubmitted;
  const dirty = JSON.stringify(draft) !== JSON.stringify(current.draft);
  const valid = destinationsLoaded && draft.content.trim() && draft.channels.length > 0 && draft.channels.every((platform) => destinations.some((destination) => destination.platform === platform && destination.id === draft.channelSelections[platform] && destination.ready));
  const requestId = (fingerprint: string) => {
    if (requestRef.current?.fingerprint !== fingerprint) requestRef.current = { fingerprint, id: crypto.randomUUID() };
    return requestRef.current.id;
  };
  const execute = async (decision?: "approve" | "reject") => {
    if (busy) return;
    setBusy(true); setError(null);
    const abort = new AbortController(); controller.current = abort;
    try {
      if (decision) {
        await growthAgents.decide(current, decision, requestId(`${current.id}:${current.payloadDigest}:${decision}`), abort.signal);
        if (mounted.current) setDecisionSubmitted(true);
      } else {
        const value = await growthAgents.revise(current, draft, requestId(JSON.stringify({ id: current.id, digest: current.payloadDigest, draft })), abort.signal);
        if (!mounted.current) return;
        setReplacement(value.review); setDraft(value.review.draft); setEditing(false);
      }
      if (mounted.current) { requestRef.current = null; await agents.refresh(); }
    } catch (cause) { if (mounted.current && !abort.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to record this decision. Retry to check its status."); }
    finally { if (mounted.current) setBusy(false); }
  };
  const route = safeGrowthRoute(current.result?.route);
  return <section className="rounded-lg border border-border bg-card p-4" aria-label="Draft review">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="text-sm font-semibold">{current.state === "saved" ? "Draft saved" : "Review draft"}</h3><p className="mt-1 text-xs text-muted-foreground">{current.state === "uncertain" ? "Save outcome unknown. Check the original operation before trying again." : expired && current.state === "proposed" ? "This proposal expired." : current.state === "proposed" ? "Save as a draft. Publishing needs a separate action." : current.state.replaceAll("_", " ")}</p></div>{actionable ? <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setEditing((value) => !value)}><Pencil className="mr-1.5 size-3.5" />{editing ? "Close editor" : "Edit"}</Button> : null}</div>
    {editing && actionable ? <div className="mt-4 space-y-3"><label className="block text-xs font-medium">Title<Input className="mt-1" value={draft.title} maxLength={200} onChange={(event) => setDraft({ ...draft, title: event.target.value })} disabled={busy} /></label><label className="block text-xs font-medium">Content<Textarea className="mt-1 min-h-36" value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} disabled={busy} /></label>{draft.variants?.map((variant, index) => <label key={variant.platform} className="block text-xs font-medium">{variant.platform} version<Textarea className="mt-1 min-h-24" value={variant.content} disabled={busy} onChange={(event) => setDraft((value) => ({ ...value, variants: value.variants?.map((item, itemIndex) => itemIndex === index ? { ...item, content: event.target.value } : item) }))} /></label>)}<fieldset className="space-y-2"><legend className="mb-2 text-xs font-medium">Destinations</legend>{destinations.length ? destinations.map((destination) => <label key={destination.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.channelSelections[destination.platform] === destination.id && draft.channels.includes(destination.platform)} disabled={busy || !destination.ready} onChange={(event) => setDraft((value) => {
      const channels = value.channels.filter((platform) => platform !== destination.platform);
      const channelSelections = { ...value.channelSelections };
      if (event.target.checked) { channels.push(destination.platform); channelSelections[destination.platform] = destination.id; }
      else delete channelSelections[destination.platform];
      return { ...value, channels, channelSelections };
    })} /><span>{destination.label}<span className="ml-1 text-xs text-muted-foreground">{destination.platform}{destination.ready ? "" : " · Unavailable"}</span></span></label>) : <p className="text-xs text-muted-foreground">No destinations available. <Link to="/connections" className="underline underline-offset-2">Manage connections</Link></p>}</fieldset></div> : <div className="mt-3 space-y-2"><p className="text-sm font-medium">{current.draft.title || "Untitled draft"}</p><p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{current.draft.content}</p>{current.draft.variants?.map((variant) => <div key={variant.platform}><p className="text-xs font-medium">{variant.platform}</p><p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">{variant.content}</p></div>)}<p className="text-xs text-muted-foreground">{current.draft.channels.length ? current.draft.channels.map((platform) => { const destination = destinations.find((item) => item.id === current.draft.channelSelections[platform] && item.platform === platform); return destination ? `${destination.label} · ${platform}` : destinationsLoaded ? "Destination unavailable" : "Checking destinations…"; }).join(", ") : "Choose a destination"}</p></div>}
    {actionable ? <div className="mt-4 flex flex-wrap gap-2">{dirty ? <Button type="button" size="sm" disabled={busy || !valid} onClick={() => void execute()}>{busy ? <LoaderCircle className="mr-1.5 size-3.5 animate-spin" /> : null}Update proposal</Button> : <Button type="button" size="sm" disabled={busy || !valid} onClick={() => void execute("approve")}><Check className="mr-1.5 size-3.5" />Save draft</Button>}<Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void execute("reject")}>Reject</Button></div> : null}
    {route && current.result?.state === "saved" ? <Link to={route} className="mt-3 inline-flex min-h-9 items-center text-sm font-medium text-primary underline underline-offset-4">Open draft</Link> : null}
    {error ? <p className="mt-3 text-sm text-destructive" role="alert">{error}</p> : null}
  </section>;
}
