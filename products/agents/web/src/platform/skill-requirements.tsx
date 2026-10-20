import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, message, organizationPath, type CapabilityBinding, type Catalogue, type Configuration, type ConnectionList, type ConnectorRecord, type SkillPackage } from "./api";
import { remoteOperationLabel } from "./mcp-operation-picker";
import { ErrorMessage } from "./shell";

const runtimeNames: Record<string, string> = { business: "Business agent", workspace: "Workspace", "python-analysis-v1": "Python analysis" };
const permissionNames: Record<string, string> = { "model.reply": "Reply to messages", "skill.read": "Read selected skills", "sandbox.execute": "Run analysis", "artifact.read": "Read artifacts", "artifact.write": "Create artifacts", "connected.read": "Read connected records", "connected.execute": "Use connected tools", "knowledge.read": "Read approved knowledge", "memory.read": "Read reviewed memory", "memory.propose": "Propose memory" };
const protocolNames: Record<string, string> = { "remote-mcp-v1": "MCP connection", "custom-api-v1": "API connection" };

export function SkillRequirements({ organizationId, agentId, skill, configuration, onChange, save, connect, configure }: {
  organizationId: string; agentId: string; skill: SkillPackage; configuration: Configuration; onChange: (value: Configuration) => void;
  save?: () => Promise<boolean>; connect: (profile: string, connectorId?: string) => void; configure: (section: "tools" | "configuration", setup?: string) => void;
}) {
  const requirements = skill.requires;
  const [data, setData] = useState<{ bindings: CapabilityBinding[]; connections: ConnectionList["connections"]; connectors: ConnectorRecord[]; catalogue: Catalogue } | null>(null);
  const [needsSave, setNeedsSave] = useState(false), [saving, setSaving] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]), [error, setError] = useState(""), [attempt, setAttempt] = useState(0);
  const path = organizationPath(organizationId), needsConnections = Boolean(requirements?.connectionProfiles.length);
  useEffect(() => {
    if (!needsConnections) return; let live = true;
    Promise.all([api<{ bindings: CapabilityBinding[] }>(`${path}/tool-bindings`), api<ConnectionList>(`${path}/connections`), api<{ connectors: ConnectorRecord[] }>(`${path}/connectors`), api<Catalogue>(`${path}/catalogue/tools?agentId=${encodeURIComponent(agentId)}`)]).then(([bindings, connections, connectors, catalogue]) => { if (live) { setData({ bindings: bindings.bindings, connections: connections.connections, connectors: connectors.connectors, catalogue }); setError(""); } }).catch(e => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [path, agentId, needsConnections, attempt]);
  if (!requirements || ![...requirements.connectionProfiles, ...requirements.permissions, ...requirements.runtimes].length) return <p className="text-sm text-muted-foreground">No additional requirements.</p>;
  const availableIds = new Set(data?.catalogue.entries.filter(item => item.readiness.state === "ready").flatMap(item => item.configuration.connectedToolBindingIds) ?? []);
  const current = data?.bindings.filter(binding => binding.connection && (availableIds.has(binding.id) || data.connections.some(connection => connection.id === binding.connection!.id && connection.state === "active" && Date.parse(connection.expiresAt) > Date.now() && connection.policyRevision === binding.connection!.policyRevision))) ?? [];
  const selected = configuration.connectedToolBindingIds ?? [];
  return <section aria-label="Skill requirements" className="space-y-3"><ErrorMessage value={error} />{error ? <Button size="sm" variant="outline" onClick={() => setAttempt(value => value + 1)}>Refresh requirements</Button> : null}
    {requirements.connectionProfiles.map(profile => {
      const bindings = current.filter(binding => binding.connection?.profileId === profile), selectedBindings = bindings.filter(binding => selected.includes(binding.id));
      const connector = data?.connectors.find(record => record.profileId === profile);
      const supported = Boolean(connector || ["remote-mcp-v1", "custom-api-v1"].includes(profile));
      return <div className="space-y-2" key={profile}><p className="text-sm font-medium">{connector?.name ?? protocolNames[profile] ?? "Additional connection"}</p>{selectedBindings.length ? <p className="text-xs text-muted-foreground">Connected tools selected</p> : <>
        <p className="text-sm text-muted-foreground">Select connected tools for this agent.</p>{bindings.length ? <fieldset className="space-y-2"><legend className="sr-only">Required connection tools</legend>{bindings.map(binding => <label key={binding.id} className="flex gap-2 text-sm"><input type="checkbox" checked={chosen.includes(binding.id)} onChange={event => setChosen(value => event.target.checked ? [...value, binding.id] : value.filter(id => id !== binding.id))} /><span className="break-words">{remoteOperationLabel(binding.definition)}<span className="block text-xs text-muted-foreground">{data?.connections.find(connection => connection.id === binding.connection?.id)?.name ?? data?.catalogue.entries.find(item => item.action.connectionId === binding.connection?.id)?.name}</span></span></label>)}<Button type="button" size="sm" variant="outline" disabled={!chosen.some(id => bindings.some(binding => binding.id === id)) || new Set([...selected, ...chosen]).size > 8} onClick={() => { onChange({ ...configuration, connectedToolBindingIds: [...new Set([...selected, ...chosen.filter(id => bindings.some(binding => binding.id === id))])] }); setChosen([]); setNeedsSave(true); }}>Use selected tools</Button></fieldset> : null}
        {supported && connector?.readiness.available !== false ? <Button type="button" size="sm" variant="outline" disabled={!data} onClick={() => connect(profile, connector?.id)}>Connect {connector?.name ?? "account"}</Button> : data ? <p className="text-sm text-muted-foreground">{connector?.readiness.reasons.map(reason => reason.message).join(" ") || "This connection is unavailable."}</p> : <p className="text-sm text-muted-foreground">Checking connections…</p>}
      </>}</div>;
    })}
    {requirements.runtimes.map(runtime => <div className="space-y-2" key={runtime}><p className="text-sm">{runtimeNames[runtime] ?? "Additional runtime"}</p>{runtime === configuration.executionKind || runtime === "python-analysis-v1" && configuration.capabilities.sandbox.enabled ? <p className="text-xs text-muted-foreground">Configured</p> : runtime === "python-analysis-v1" ? <Button type="button" size="sm" variant="outline" onClick={() => configure("configuration", "analysis")}>Configure analysis</Button> : <p className="text-sm text-muted-foreground">This runtime is unavailable.</p>}</div>)}
    {requirements.permissions.map(permission => <div className="space-y-2" key={permission}><p className="text-sm">{permissionNames[permission] ?? "Additional permission"}</p>{["sandbox.execute", "artifact.read", "artifact.write"].includes(permission) ? requirements.runtimes.includes("python-analysis-v1") ? <p className="text-xs text-muted-foreground">Configured through Python analysis.</p> : <Button type="button" size="sm" variant="outline" onClick={() => configure("configuration", "analysis")}>Review analysis access</Button> : ["connected.read", "connected.execute", "knowledge.read", "memory.read", "memory.propose"].includes(permission) ? <Button type="button" size="sm" variant="outline" onClick={() => configure("tools")}>Review tool access</Button> : <p className="text-xs text-muted-foreground">This permission must be available in the agent's configured capabilities.</p>}</div>)}
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Requirement identifiers</summary><ul className="mt-2 space-y-1 break-words">{requirements.connectionProfiles.map(value => <li key={`connection:${value}`}>Connection: {value}</li>)}{requirements.runtimes.map(value => <li key={`runtime:${value}`}>Runtime: {value}</li>)}{requirements.permissions.map(value => <li key={`permission:${value}`}>Permission: {value}</li>)}</ul></details>
    {needsSave && save ? <Button type="button" size="sm" disabled={saving} onClick={() => { setSaving(true); setError(""); void save().then(saved => { if (saved) setNeedsSave(false); }).catch(e => setError(message(e))).finally(() => setSaving(false)); }}>{saving ? "Saving…" : "Save configuration"}</Button> : null}
    <p className="text-xs text-muted-foreground">Save configuration after making changes. Skill requirements never grant access automatically.</p>
  </section>;
}
