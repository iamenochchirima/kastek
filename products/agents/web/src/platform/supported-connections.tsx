import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, message, type ConnectorRecord } from "./api";
import { CalendarServiceConnections } from "./google-calendar";
import { ErrorMessage } from "./shell";

export function SupportedConnections({ organizationPath, owner }: { organizationPath: string; owner: boolean }) {
  const [connectors, setConnectors] = useState<ConnectorRecord[]>([]), [error, setError] = useState(""), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    api<{ connectors: ConnectorRecord[] }>(`${organizationPath}/connectors`).then(result => { if (live) { setConnectors(result.connectors); setError(""); } }).catch(e => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [organizationPath, attempt]);
  return <><ErrorMessage value={error} />{error ? <Button size="sm" variant="outline" onClick={() => setAttempt(value => value + 1)}>Refresh integrations</Button> : null}{connectors.map(connector => connector.setup?.kind === "calendar_service" ? <CalendarServiceConnections key={connector.id} connector={{ ...connector, setup: connector.setup }} path={`${organizationPath}/${encodeURIComponent(connector.setup.apiPath)}`} owner={owner} /> : <div key={connector.id} className="management-row min-w-0 space-y-1"><h2 className="break-words font-medium">{connector.name}</h2><p className="break-words text-sm text-muted-foreground">{connector.description}</p><p className="break-words text-xs text-muted-foreground">{connector.readiness.reasons.map(reason => reason.message).join(" ") || (connector.readiness.available && (!connector.setup || connector.setup.kind === "existing_connections") ? "Available from Tools" : "Setup unavailable")}</p></div>)}</>;
}
