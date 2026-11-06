import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, message, organizationPath } from "./api";
import { ErrorMessage } from "./shell";
import { AgentAvatar, agentAvatarOptions, randomAgentAvatarId } from "./agent-avatar";
import "./edit-agent-dialog.css";

type EditableAgent = { id: string; name: string; avatar: string };
type Props = { organizationId: string; agent: EditableAgent | null; role: string; onOpenChange: (open: boolean) => void; onSaved: (agent: EditableAgent) => void };

export function EditAgentDialog({ organizationId, agent, role, onOpenChange, onSaved }: Props) {
  const [name, setName] = useState(""), [avatar, setAvatar] = useState<string>(randomAgentAvatarId()), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { if (!agent) return; setName(agent.name); setAvatar(agent.avatar); setError(""); }, [agent]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!agent || busy || !name.trim()) return;
    setBusy(true); setError("");
    try {
      const { agent: saved } = await api<{ agent: EditableAgent }>(`${organizationPath(organizationId)}/agents/${encodeURIComponent(agent.id)}`, { name: name.trim(), avatar }, "PATCH");
      onSaved(saved);
      toast.success("Agent updated");
      onOpenChange(false);
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }
  return <Dialog open={Boolean(agent)} onOpenChange={value => { if (!busy) onOpenChange(value); }}>
    <DialogContent className="sm:max-w-md" showCloseButton={!busy} onInteractOutside={event => { if (busy) event.preventDefault(); }} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>Edit agent</DialogTitle><DialogDescription className="sr-only">Change this agent's name or avatar. Its role, tools and permissions stay the same.</DialogDescription></DialogHeader>
      <form className="agent-edit-dialog" onSubmit={event => void save(event)}>
        <div className="agent-edit-identity"><AgentAvatar id={avatar} size={52} /><p>Renaming does not change its role, tools or permissions.</p></div>
        <label className="agent-edit-field">Name<Input required maxLength={120} autoFocus value={name} onChange={event => setName(event.target.value)} /></label>
        <div className="agent-edit-field">Role<span className="agent-edit-role">{role}</span></div>
        <div>
          <div className="agent-edit-avatar-head"><span>Avatar</span><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setAvatar(randomAgentAvatarId())}>Shuffle</Button></div>
          <div className="agent-edit-avatar-grid" role="group" aria-label="Avatar">
            {agentAvatarOptions.map(option => <button key={option.id} type="button" className="agent-edit-avatar-option" aria-label={option.label} aria-pressed={avatar === option.id} disabled={busy} onClick={() => setAvatar(option.id)}><AgentAvatar id={option.id} size={44} /></button>)}
          </div>
          <p className="agent-edit-hint">Choose an avatar or shuffle to pick one.</p>
        </div>
        <ErrorMessage value={error} />
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={busy || !name.trim() || (name.trim() === agent?.name && avatar === agent?.avatar)}>{busy ? "Saving…" : "Save changes"}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
