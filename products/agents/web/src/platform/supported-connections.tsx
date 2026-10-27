import { useEffect, useState } from "react";
import { PiPlugs as Plug } from "react-icons/pi";
import { BrandIcon } from "./brand-icon";
import { Button } from "@/components/ui/button";
import { api, message, type ConnectorRecord } from "./api";
import { ProviderConnections } from "./provider-connections";
import { ErrorMessage } from "./shell";

export function SupportedConnections({ organizationPath, owner, query = "" }: { organizationPath: string; owner: boolean; query?: string }) {
  const [connectors, setConnectors] = useState<ConnectorRecord[]>([]), [error, setError] = useState(""), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    api<{ connectors: ConnectorRecord[] }>(`${organizationPath}/connectors`).then(result => { if (live) { setConnectors(result.connectors); setError(""); } }).catch(e => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [organizationPath, attempt]);
  return <><ErrorMessage value={error} />{error ? <Button size="sm" variant="outline" onClick={() => setAttempt(value => value + 1)}>Refresh integrations</Button> : null}{connectors.length ? <div className="connection-columns" aria-hidden="true"><span /><span>Name</span><span>Description</span><span>Status</span></div> : null}<div className="connection-grid">{connectors.filter(connector => `${connector.name} ${connector.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(connector => (connector.setup?.kind === "calendar_service" || connector.setup?.kind === "crm_service") ? <ProviderConnections key={connector.id} connector={{ ...connector, setup: connector.setup }} path={`${organizationPath}/providers/${encodeURIComponent(connector.id)}`} owner={owner} /> : <div key={connector.id} className="connection-entry"><span className="connection-entry-icon"><BrandIcon name={connector.id} fallback={<Plug size={19} aria-hidden="true" />} /></span><div className="connection-entry-body"><h2>{connector.name}</h2><div className="connection-entry-description"><p>{connector.description}</p><p>{connector.readiness.reasons.map(reason => reason.message).join(" ") || (connector.readiness.available && (!connector.setup || connector.setup.kind === "existing_connections") ? "Available from Tools" : "Setup unavailable")}</p></div></div></div>)}</div></>;
}
