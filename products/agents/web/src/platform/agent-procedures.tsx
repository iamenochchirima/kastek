import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, message, organizationPath, type Configuration } from "./api";
import { ErrorMessage, Loading } from "./shell";

type Procedure = {
  id: string;
  version: string;
  name: string;
  description: string;
  readiness: { state: "ready" | "unavailable"; reasons: Array<{ code: string; message: string }> };
};

export function AgentProcedures({ organizationId, agentId, draftRevision, configuration, onChange, disabled }: {
  organizationId: string;
  agentId: string;
  draftRevision: number;
  configuration: Configuration;
  onChange(value: Configuration): void;
  disabled: boolean;
}) {
  const [entries, setEntries] = useState<Procedure[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const path = `${organizationPath(organizationId)}/agents/${encodeURIComponent(agentId)}/procedures`;
  useEffect(() => {
    let current = true;
    api<{ entries: Procedure[] }>(path).then(result => {
      if (current) { setEntries(result.entries); setError(""); }
    }).catch(error => { if (current) setError(message(error)); });
    return () => { current = false; };
  }, [path, draftRevision, attempt]);

  const selected = configuration.procedures ?? [];
  function toggle(procedure: Procedure, enabled: boolean) {
    const remaining = selected.filter(value => value.id !== procedure.id);
    onChange({ ...configuration, procedures: enabled ? [...remaining, { id: procedure.id, version: procedure.version }] : remaining });
  }
  return <fieldset className="space-y-3 border-t border-border pt-4" disabled={disabled}>
    <legend className="text-sm font-medium">Workflows</legend>
    <ErrorMessage value={error} />
    {error ? <Button type="button" size="sm" variant="outline" onClick={() => setAttempt(value => value + 1)}>Retry</Button> : !entries ? <Loading /> : null}
    {entries?.map(procedure => {
      const enabled = selected.some(value => value.id === procedure.id && value.version === procedure.version);
      const reasons = procedure.readiness.reasons.map(reason => reason.message).join(" ");
      return <label key={`${procedure.id}:${procedure.version}`} className="flex min-h-11 items-start gap-3 text-sm">
        <input className="mt-1 size-4 shrink-0 accent-primary" type="checkbox" checked={enabled} disabled={!enabled && procedure.readiness.state !== "ready"} onChange={event => toggle(procedure, event.target.checked)} />
        <span className="min-w-0 break-words"><span className="block font-medium">{procedure.id === "after-hours-assistance" ? "After-hours support" : procedure.name}</span>{procedure.description ? <span className="mt-1 block text-xs text-muted-foreground">{procedure.description}</span> : null}{reasons ? <span className="mt-1 block text-xs text-muted-foreground">{reasons}</span> : null}</span>
      </label>;
    })}
    {entries?.length === 0 ? <p className="text-sm text-muted-foreground">No workflows available</p> : null}
    {entries ? selected.filter(value => !entries.some(entry => entry.id === value.id && entry.version === value.version)).map(value => <div key={`${value.id}:${value.version}`} className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>Unavailable workflow</span><Button type="button" size="sm" variant="ghost" onClick={() => onChange({ ...configuration, procedures: selected.filter(entry => entry !== value) })}>Remove</Button></div>) : null}
  </fieldset>;
}
