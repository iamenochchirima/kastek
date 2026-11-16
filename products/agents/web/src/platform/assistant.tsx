import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { api, message, organizationPath } from "./api";
import { ErrorMessage, Loading, useWorkspace } from "./shell";

export type Assistant = { state: "absent" | "draft" | "configured" | "deleted"; modelReady: boolean; agent: { id: string; name: string } | null };
type MemberLink = { id: string; connectionId: string; kind: "telegram" | "whatsapp"; state: "challenge" | "pending" | "active" | "revoked" | "expired"; senderLabel: string | null; expiresAt: string | null; conversationId: string | null };
type MemberDelivery = { id: string; linkId: string; taskId: string | null; state: string; reason: string | null; segment: number; updatedAt: string };
type MemberChannels = { enabled?: boolean; links: MemberLink[]; deliveries?: MemberDelivery[]; connections: { id: string; kind: "telegram" | "whatsapp"; label: string }[] };
type Challenge = { id: string; token: string; expiresAt: string };
const channelName = (kind: MemberLink["kind"]) => kind === "telegram" ? "Telegram" : "WhatsApp";
function deliveryLabel(deliveries: MemberDelivery[], linkId: string) {
  const latest = deliveries.filter(delivery => delivery.linkId === linkId);
  if (!latest.length) return null;
  const task = latest.filter(delivery => delivery.taskId === latest[0].taskId);
  if (task.some(delivery => delivery.state === "unknown")) return "Delivery unknown";
  if (task.some(delivery => delivery.state === "failed")) return "Delivery failed";
  if (task.some(delivery => delivery.state === "suppressed")) return "Available in app";
  if (task.some(delivery => ["pending", "sending"].includes(delivery.state))) return "Delivery pending";
  return null;
}

export function MemberChannelsPanel({ agentPath, ready }: { agentPath: string | null; ready: boolean }) {
  const { organizationId, session } = useWorkspace();
  const { confirm } = useConfirmationDialog();
  const path = `${organizationPath(organizationId)}/member-channels`;
  const organizationName = session.organizations.find(organization => organization.id === organizationId)?.name;
  const [data, setData] = useState<MemberChannels | null>(null);
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<(Challenge & { connectionId: string }) | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const result = await api<MemberChannels>(path);
        if (!live) return;
        setData(result); setError("");
        if (challenge && Date.parse(challenge.expiresAt) > Date.now() || result.links.some(link => ["pending", "active"].includes(link.state))) timer = setTimeout(() => void load(), 2_000);
      } catch (e) { if (live) setError(message(e)); }
    }
    void load();
    return () => { live = false; clearTimeout(timer); };
  }, [path, generation, challenge]);
  useEffect(() => {
    if (!challenge) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [challenge]);
  const challengeExpired = Boolean(challenge && Date.parse(challenge.expiresAt) <= now);
  const challengeConsumed = Boolean(challenge && data?.links.some(link => ["pending", "active"].includes(link.state) && (link.id === challenge.id || link.connectionId === challenge.connectionId)));
  async function pair(connectionId: string) {
    setBusy(connectionId);
    try { const result = await api<Challenge>(`${path}/challenges`, { connectionId }); setNow(Date.now()); setChallenge({ ...result, connectionId }); }
    catch (e) { toast.error(message(e)); }
    finally { setBusy(null); }
  }
  async function updateLink(link: MemberLink, action: "confirm" | "revoke") {
    const accepted = await confirm(action === "confirm" ? { title: "Link this account?", description: `${link.senderLabel ?? "Unknown sender"} on ${channelName(link.kind)} will access Ask AI in ${organizationName}.`, confirmLabel: "Confirm account" } : { title: "Unlink account?", description: `${link.senderLabel ?? channelName(link.kind)} will lose private Ask AI access.`, confirmLabel: "Unlink", variant: "destructive" });
    if (!accepted) return;
    setBusy(link.id);
    try {
      await api(action === "confirm" ? `${path}/${encodeURIComponent(link.id)}/confirm` : `${path}/${encodeURIComponent(link.id)}`, action === "confirm" ? {} : undefined, action === "confirm" ? "POST" : "DELETE");
      setChallenge(null); setGeneration(value => value + 1); toast.success(action === "confirm" ? "Account linked" : "Account unlinked");
    } catch (e) { toast.error(message(e)); }
    finally { setBusy(null); }
  }
  return <section aria-labelledby="member-channels-title" className="space-y-4 border-t border-border pt-6">
    <h2 id="member-channels-title" className="text-lg font-medium">Your messaging accounts</h2>
    <p className="text-sm text-muted-foreground">Private access to {organizationName}</p>
    <ErrorMessage value={error} />
    {error ? <Button variant="outline" onClick={() => setGeneration(value => value + 1)}>Retry accounts</Button> : !data ? <Loading /> : <>
      {data.enabled === false ? <p className="text-sm text-muted-foreground">Private messaging unavailable</p> : !ready ? <p className="text-sm text-muted-foreground">Finish Ask AI setup before linking an account.</p> : null}
      {data.connections.length === 0 ? <p className="text-sm text-muted-foreground">No messaging connections available</p> : <div className="flex flex-wrap gap-2">{data.connections.map(connection => <Button key={connection.id} variant="outline" disabled={!ready || data.enabled === false || busy !== null || data.links.some(link => link.connectionId === connection.id && ["pending", "active"].includes(link.state))} onClick={() => void pair(connection.id)}>{busy === connection.id ? "Preparing…" : `Link ${connection.label || channelName(connection.kind)}`}</Button>)}</div>}
      {challenge && !challengeConsumed ? <div className="space-y-2 rounded-md border border-border p-4" role="status">
        {challengeExpired ? <p className="text-sm">Pairing code expired. Link the account again.</p> : <>
          <p className="text-sm">Send this in a private chat with {data.connections.find(connection => connection.id === challenge.connectionId)?.label ?? "the connected account"}.</p>
          <code className="block break-all rounded bg-muted p-3 text-sm select-all">/pair {challenge.token}</code>
          <p className="text-xs text-muted-foreground">Expires {new Date(challenge.expiresAt).toLocaleTimeString()}. Return here to confirm the account.</p>
        </>}
      </div> : null}
      <ul className="divide-y divide-border">{data.links.filter(link => ["pending", "active"].includes(link.state)).map(link => <li key={link.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="min-w-0"><p className="break-all text-sm font-medium">{link.senderLabel ?? channelName(link.kind)}</p><p className="text-xs text-muted-foreground">{channelName(link.kind)} · {link.state === "pending" ? "Confirm account" : "Linked"}</p>{deliveryLabel(data.deliveries ?? [], link.id) ? <p role="status" className="mt-1 text-xs text-muted-foreground">{deliveryLabel(data.deliveries ?? [], link.id)}</p> : null}</div>
        <div className="flex flex-wrap gap-2">
          {link.state === "pending" && link.senderLabel ? <Button size="sm" disabled={busy !== null} onClick={() => void updateLink(link, "confirm")}>{busy === link.id ? "Saving…" : "Confirm account"}</Button> : null}
          {link.state === "active" && link.conversationId && agentPath ? <Button asChild size="sm" variant="outline"><Link to={`${agentPath}/conversations/${encodeURIComponent(link.conversationId)}`}>Open conversation</Link></Button> : null}
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void updateLink(link, "revoke")}>{busy === link.id ? "Saving…" : "Unlink"}</Button>
        </div>
      </li>)}</ul>
    </>}
  </section>;
}
