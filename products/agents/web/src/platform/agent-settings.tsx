import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, message, organizationPath, type Agent } from "./api";
import { ErrorMessage } from "./shell";
import { AgentAvatar, agentAvatarOptions } from "./agent-avatar";

export function AgentSettings({ organizationId, agent, onUpdated, onDelete }: {
  organizationId: string; agent: Agent; onUpdated: (agent: Agent) => void; onDelete: () => void;
}) {
  const path = `${organizationPath(organizationId)}/agents/${encodeURIComponent(agent.id)}`;
  const [name, setName] = useState(agent.name), [avatar, setAvatar] = useState(agent.avatar);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const unchanged = name.trim() === agent.name && avatar === agent.avatar;
  async function save(event: FormEvent) {
    event.preventDefault(); setError(""); setBusy(true);
    try {
      const result = await api<{ agent: Agent }>(path, { name: name.trim(), avatar }, "PATCH");
      onUpdated(result.agent); toast.success("Agent updated");
    } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }
  return <section className="agent-section agent-settings-page">
    <header className="agent-section-heading"><div><h1>Settings</h1><p>Agent identity and lifecycle.</p></div></header>
    <ErrorMessage value={error} />
    <form className="agent-settings-form" onSubmit={event => void save(event)}>
      <fieldset className="agent-avatar-picker"><legend>Avatar</legend><div>{agentAvatarOptions.map(option => <button type="button" key={option.id} aria-label={option.label} aria-pressed={avatar === option.id} disabled={busy} onClick={() => setAvatar(option.id)}><AgentAvatar id={option.id} size={40} /></button>)}</div></fieldset>
      <label className="block space-y-2 text-sm font-medium">Name<Input required maxLength={120} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
      <div><Button type="submit" disabled={busy || unchanged || !name.trim()}>{busy ? "Saving…" : "Save changes"}</Button></div>
    </form>
    <section className="agent-settings-danger"><div><h2>Delete agent</h2><p>Connected channels and automations will stop. Conversation history and customer records are retained.</p></div><Button type="button" variant="destructive" onClick={onDelete}>Delete agent</Button></section>
  </section>;
}
