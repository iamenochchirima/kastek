import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, message, terminal, type Task } from "./api";
import { ErrorMessage } from "./shell";

export function TaskProgress({ task, endpoint, token }: { task: Task; endpoint: string; token?: string }) {
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<{ instruction: string; requestKey: string } | null>(null);
  const lock = useRef(false);
  const record = task.orchestration?.record;
  const canSteer = task.canSteer && !terminal(task.state);
  async function queue() {
    if (lock.current || !canSteer || !instruction.trim()) return;
    lock.current = true; setBusy(true); setError("");
    const value = instruction.trim();
    if (pending.current?.instruction !== value) pending.current = { instruction: value, requestKey: crypto.randomUUID() };
    try { await api(`${endpoint}/instructions`, pending.current, "POST", token); pending.current = null; setInstruction(""); toast.success("Instructions queued"); }
    catch (cause) { setError(message(cause)); }
    finally { lock.current = false; setBusy(false); }
  }
  if (!record && !canSteer) return null;
  return <section aria-label="Work progress" className="min-w-0 space-y-3 rounded-md border border-border p-3 text-sm">
    {record ? <details open><summary className="cursor-pointer font-medium">Work progress</summary><div className="mt-3 space-y-3">
      <p className="whitespace-pre-wrap break-words">{record.objective}</p>
      {record.steps.length ? <ol aria-label="Work steps" className="space-y-2">{record.steps.map(step => <li key={step.id} className="flex flex-wrap justify-between gap-x-3 gap-y-1"><span className="min-w-0 break-words">{step.title}</span><span className="text-xs text-muted-foreground">{step.state.replaceAll("_", " ")}</span></li>)}</ol> : null}
      {record.questions.length ? <div className="space-y-1"><h3 className="font-medium">Open questions</h3><ul className="list-inside list-disc space-y-1">{record.questions.map((question, index) => <li className="break-words" key={index}>{question}</li>)}</ul></div> : null}
    </div></details> : null}
    {canSteer ? <div className="space-y-2"><label className="block space-y-2"><span>Update instructions</span><Textarea rows={2} maxLength={4000} value={instruction} disabled={busy} onChange={event => setInstruction(event.target.value)} /></label><ErrorMessage value={error} /><Button type="button" size="sm" variant="outline" disabled={busy || !instruction.trim()} onClick={() => void queue()}>{busy ? "Queuing…" : "Queue instructions"}</Button></div> : null}
  </section>;
}
