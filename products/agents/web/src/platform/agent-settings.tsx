import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, message, organizationPath, type Agent, type AgentTransfer } from "./api";
import { ErrorMessage, useWorkspace } from "./shell";
import { AgentAvatar, agentAvatarOptions } from "./agent-avatar";

const dateLabel = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
};

export function AgentSettings({ organizationId, agent, onUpdated, onDelete }: {
  organizationId: string; agent: Agent; onUpdated: (agent: Agent) => void; onDelete: () => void;
}) {
  const { session } = useWorkspace();
  const canTransfer = session.organizations.find(organization => organization.id === organizationId)?.role === "owner";
  const path = `${organizationPath(organizationId)}/agents/${encodeURIComponent(agent.id)}`;
  const [name, setName] = useState(agent.name), [avatar, setAvatar] = useState(agent.avatar);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [transfer, setTransfer] = useState<AgentTransfer | null>(null);
  const [transferOpen, setTransferOpen] = useState(false), [email, setEmail] = useState("");
  const [transferBusy, setTransferBusy] = useState(false), [transferError, setTransferError] = useState("");
  const unchanged = name.trim() === agent.name && avatar === agent.avatar;
  useEffect(() => {
    let live = true;
    api<{ transfer: AgentTransfer | null }>(`${path}/transfers/current`)
      .then(result => { if (live) setTransfer(result.transfer); })
      .catch(() => { if (live) setTransfer(null); });
    return () => { live = false; };
  }, [path]);
  async function save(event: FormEvent) {
    event.preventDefault(); setError(""); setBusy(true);
    try {
      const result = await api<{ agent: Agent }>(path, { name: name.trim(), avatar }, "PATCH");
      onUpdated(result.agent); toast.success("Agent updated");
    } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }
  async function startTransfer(event: FormEvent) {
    event.preventDefault(); setTransferError(""); setTransferBusy(true);
    try {
      const result = await api<{ transfer: AgentTransfer }>(`${path}/transfers`, { email: email.trim() }, "POST");
      setTransfer(result.transfer); setTransferOpen(false); setEmail(""); toast.success("Transfer sent");
    } catch (reason) { setTransferError(message(reason)); } finally { setTransferBusy(false); }
  }
  async function cancelTransfer() {
    if (!transfer) return;
    setTransferError(""); setTransferBusy(true);
    try {
      await api(`${path}/transfers/${encodeURIComponent(transfer.id)}`, undefined, "DELETE");
      setTransfer(null); toast.success("Transfer cancelled");
    } catch (reason) { setTransferError(message(reason)); } finally { setTransferBusy(false); }
  }
  return <section className="agent-section agent-settings-page">
    <header className="agent-section-heading"><div><h1>Settings</h1><p>Agent identity and lifecycle.</p></div></header>
    <ErrorMessage value={error} />
    <form className="agent-settings-form" onSubmit={event => void save(event)}>
      <fieldset className="agent-avatar-picker"><legend>Avatar</legend><div>{agentAvatarOptions.map(option => <button type="button" key={option.id} aria-label={option.label} aria-pressed={avatar === option.id} disabled={busy} onClick={() => setAvatar(option.id)}><AgentAvatar id={option.id} size={40} /></button>)}</div></fieldset>
      <label className="block space-y-2 text-sm font-medium">Name<Input required maxLength={120} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
      <div><Button type="submit" disabled={busy || unchanged || !name.trim()}>{busy ? "Saving…" : "Save changes"}</Button></div>
    </form>
    {canTransfer ? <section className="agent-settings-transfer"><div><h2>Transfer agent</h2>{transfer ? <p>Waiting for {transfer.targetEmail} to accept. Expires {dateLabel(transfer.expiresAt)}. The agent is locked until the transfer settles.</p> : <p>Send this agent to another account. The recipient chooses the workspace when they accept.</p>}</div>{transfer ? <Button type="button" variant="outline" disabled={transferBusy} onClick={() => void cancelTransfer()}>{transferBusy ? "Cancelling…" : "Cancel transfer"}</Button> : <Button type="button" variant="outline" onClick={() => { setTransferError(""); setTransferOpen(true); }}>Transfer agent</Button>}</section> : null}
    {transferError && !transferOpen ? <ErrorMessage value={transferError} /> : null}
    <section className="agent-settings-danger"><div><h2>Delete agent</h2><p>Connected channels and automations will stop. Conversation history and customer records are retained. Attached knowledge stays in the workspace.</p></div><Button type="button" variant="destructive" disabled={Boolean(transfer)} onClick={onDelete}>Delete agent</Button></section>
    <Dialog open={transferOpen} onOpenChange={value => { if (!transferBusy) setTransferOpen(value); }}>
      <DialogContent showCloseButton={!transferBusy}>
        <DialogHeader><DialogTitle>Transfer {agent.name}</DialogTitle><DialogDescription>The recipient gets a copy of this agent and its knowledge. They choose the workspace when they accept.</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={event => void startTransfer(event)}>
          <label className="block space-y-2 text-sm font-medium">Recipient email<Input autoFocus type="email" required maxLength={254} value={email} disabled={transferBusy} onChange={event => setEmail(event.target.value)} /></label>
          <p className="text-xs text-muted-foreground">Model connections, channels, domains, conversations and version history do not move.</p>
          <ErrorMessage value={transferError} />
          <DialogFooter><Button type="button" variant="outline" disabled={transferBusy} onClick={() => setTransferOpen(false)}>Cancel</Button><Button type="submit" disabled={transferBusy || !email.trim()}>{transferBusy ? "Sending…" : "Send transfer"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </section>;
}
