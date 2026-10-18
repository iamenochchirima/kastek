import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, message, readStored, writeStored } from "./api";
import { CustomerChat } from "./customer-chat";
import { ErrorMessage, Loading } from "./shell";

const sessions = new Map<string, Promise<string>>();
function visitorSession(path: string, id: string): Promise<string> {
  const existing = readStored<string>(`agents.visitor.${id}`);
  if (existing) return Promise.resolve(existing);
  if (!sessions.has(id)) sessions.set(id, api<{ token: string }>(`${path}/session`, {}).then(result => { writeStored(`agents.visitor.${id}`, result.token); return result.token; }).finally(() => { sessions.delete(id); }));
  return sessions.get(id)!;
}
export function WebsiteChat() {
  const { deploymentId = "" } = useParams();
  const path = `/api/website/${encodeURIComponent(deploymentId)}`;
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { let live = true; Promise.all([api<{ name: string }>(path), visitorSession(path, deploymentId)]).then(([result, visitorToken]) => { if (!live) return; setName(result.name); setToken(visitorToken); }).catch(e => { if (live) setError(message(e)); }); return () => { live = false; }; }, [deploymentId, path]);
  return <main className="dashboard-theme min-h-dvh bg-background p-4 text-foreground sm:p-6"><div className="mx-auto max-w-2xl space-y-6"><h1 className="break-words text-xl font-semibold">{name || "Website chat"}</h1><ErrorMessage value={error} />{token && name ? <CustomerChat path={path} token={token} deploymentId={deploymentId} /> : !error ? <Loading /> : null}</div></main>;
}
