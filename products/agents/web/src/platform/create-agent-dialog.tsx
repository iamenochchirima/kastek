import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, message, organizationPath, type Agent } from "./api";
import { ErrorMessage } from "./shell";

export function CreateAgentDialog({ open, onOpenChange, organizationId, onCreated }: {
  open: boolean; onOpenChange: (open: boolean) => void; organizationId: string; onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<{ input: string; operationId: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !name.trim()) return;
    const input = { name: name.trim(), ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
      ...(instructions.trim() ? { instructions: instructions.trim() } : {}) };
    const serialized = JSON.stringify(input);
    if (request.current?.input !== serialized) request.current = { input: serialized, operationId: crypto.randomUUID() };
    setBusy(true); setError("");
    try {
      const result = await api<{ agent: Agent }>(`${organizationPath(organizationId)}/agents`, { ...input, operationId: request.current.operationId });
      request.current = null;
      setName(""); setPurpose(""); setInstructions("");
      onCreated(result.agent.id);
    } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }

  return <Dialog open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }}>
    <DialogContent showCloseButton={!busy} onInteractOutside={event => { if (busy) event.preventDefault(); }} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>Create agent</DialogTitle><DialogDescription className="sr-only">Choose the agent's name, purpose and instructions.</DialogDescription></DialogHeader>
      <form onSubmit={event => void submit(event)} className="space-y-4">
        <label className="block space-y-2 text-sm font-medium">Name<Input autoFocus required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label>
        <label className="block space-y-2 text-sm font-medium">Purpose <span className="font-normal text-muted-foreground">(optional)</span><Textarea rows={2} maxLength={600} value={purpose} onChange={event => setPurpose(event.target.value)} /></label>
        <label className="block space-y-2 text-sm font-medium">Instructions <span className="font-normal text-muted-foreground">(optional)</span><Textarea rows={4} maxLength={8000} value={instructions} onChange={event => setInstructions(event.target.value)} /></label>
        <ErrorMessage value={error} />
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create agent"}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
