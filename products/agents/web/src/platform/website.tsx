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
  const [entry, setEntry] = useState<{ deploymentId: string; name: string; token: string } | null>(null);
  const [failure, setFailure] = useState<{ deploymentId: string; message: string } | null>(null);
  const current = entry?.deploymentId === deploymentId ? entry : null;
  const error = failure?.deploymentId === deploymentId ? failure.message : "";
  useEffect(() => { try { sessionStorage.removeItem(`agents.website.${deploymentId}`); } catch { /* Canonical customer history remains authoritative. */ } let live = true;
    Promise.all([api<{ name: string }>(path), visitorSession(path, deploymentId)]).then(([result, token]) => { if (live) { setEntry({ deploymentId, name: result.name, token }); setFailure(null); } }).catch(e => { if (live) setFailure({ deploymentId, message: message(e) }); });
    return () => { live = false; };
  }, [deploymentId, path]);
  return <main className="dashboard-theme min-h-dvh bg-background p-4 text-foreground sm:p-6"><div className="mx-auto max-w-2xl space-y-6"><h1 className="break-words text-xl font-semibold">{current?.name || "Website chat"}</h1><ErrorMessage value={error} />{current ? <CustomerChat key={`${deploymentId}:${current.token}`} path={path} token={current.token} deploymentId={deploymentId} /> : !error ? <Loading /> : null}</div></main>;
}
