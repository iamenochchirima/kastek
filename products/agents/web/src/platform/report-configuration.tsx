import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Input } from "@/components/ui/input";
import { api, message, organizationPath, type Configuration, type Connection } from "./api";
import { ErrorMessage } from "./shell";

export function ReportConfiguration({ organizationId, configuration, onChange }: { organizationId: string; configuration: Configuration; onChange: (value: Configuration) => void }) {
  const workflow = configuration.capabilities.workflows;
  const [connections, setConnections] = useState<Connection[]>([]), [error, setError] = useState("");
  useEffect(() => {
    if (!workflow.enabled) return;
    let live = true;
    api<{ connections: Connection[] }>(`${organizationPath(organizationId)}/connections`).then(result => { if (live) setConnections(result.connections.filter(connection => connection.state === "active")); }).catch(e => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [organizationId, workflow.enabled]);
  return <fieldset className="space-y-4 border-t border-border pt-6"><legend className="mb-3 text-sm font-medium">Report delivery</legend><label className="flex items-start gap-3 text-sm"><input className="mt-0.5 size-4 accent-primary" type="checkbox" checked={workflow.enabled} onChange={event => onChange({ ...configuration, capabilities: { ...configuration.capabilities, workflows: event.target.checked ? { enabled: true, profileId: "report-delivery-v1", connectionId: "", reportArtifactName: "report.md", title: "Report" } : { enabled: false } } })} /><span>Prepare reports for approval</span></label>{workflow.enabled ? <><ErrorMessage value={error} /><label className="block space-y-2 text-sm">Delivery connection<select required className="w-full min-w-0 rounded-md border border-border bg-background p-2" value={workflow.connectionId} onChange={event => onChange({ ...configuration, capabilities: { ...configuration.capabilities, workflows: { ...workflow, connectionId: event.target.value } } })}><option value="">Select connection</option>{workflow.connectionId && !connections.some(connection => connection.id === workflow.connectionId) ? <option value={workflow.connectionId}>Connection unavailable</option> : null}{connections.map(connection => <option key={connection.id} value={connection.id}>{connection.name} · {connection.resource}</option>)}</select></label><Link to="/app/connections" className="inline-block text-sm underline underline-offset-4">Manage connections</Link><label className="block space-y-2 text-sm">Report file<Input required value={workflow.reportArtifactName ?? "report.md"} onChange={event => onChange({ ...configuration, capabilities: { ...configuration.capabilities, workflows: { ...workflow, reportArtifactName: event.target.value } } })} /></label><label className="block space-y-2 text-sm">Delivery title<Input required maxLength={120} value={workflow.title ?? "Report"} onChange={event => onChange({ ...configuration, capabilities: { ...configuration.capabilities, workflows: { ...workflow, title: event.target.value } } })} /></label></> : null}</fieldset>;
}
