import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, message, organizationPath, type DeliveryAction } from "./api";
import { ErrorMessage, useWorkspace } from "./shell";

export function TaskReview({ actions, onRefresh }: { actions: DeliveryAction[]; onRefresh?: () => void }) {
  const { organizationId, session } = useWorkspace();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const requestIds = useRef(new Map<string, string>());
  async function decide(action: DeliveryAction, decision: "approve" | "reject") {
    const key = `${action.id}:${action.reviewDigest}:${decision}`;
    const operationId = requestIds.current.get(key) ?? crypto.randomUUID(); requestIds.current.set(key, operationId);
    setBusy(true); setError("");
    try { await api(`${organizationPath(organizationId)}/tasks/${encodeURIComponent(action.rootTaskId)}/actions/${encodeURIComponent(action.id)}/decision`, { operationId, decision, expectedDigest: action.reviewDigest }); onRefresh?.(); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <section aria-label="Report delivery" className="space-y-4"><h3 className="font-medium">Report delivery</h3><ErrorMessage value={error} />{actions.map(action => {
    const expired = Date.parse(action.expiresAt) <= Date.now();
    const reviewer = !action.reviewerAccountId || action.reviewerAccountId === session.account.id;
    return <div key={action.id} className="space-y-4"><div className="space-y-1"><h4 className="break-words text-sm font-medium">{action.title}</h4><p className="break-all text-sm">To {action.destination.label} · {action.destination.resource}</p><p className="text-xs text-muted-foreground">{action.state.replaceAll("_", " ")} · Review expires {new Date(action.expiresAt).toLocaleString()}</p></div><details open={action.state === "pending_review"}><summary className="cursor-pointer text-sm">{action.preview.name}</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border p-4 text-xs leading-5">{action.preview.content}</pre></details>{action.state === "pending_review" ? <div className="flex flex-wrap gap-2"><Button disabled={busy || expired || !reviewer} onClick={() => void decide(action, "approve")}>Approve delivery</Button><Button variant="outline" disabled={busy || expired || !reviewer} onClick={() => void decide(action, "reject")}>Reject delivery</Button>{!reviewer ? <p className="basis-full text-sm text-muted-foreground">Awaiting the assigned reviewer.</p> : null}{expired ? <p className="basis-full text-sm text-muted-foreground">This review has expired. Refresh to check its status.</p> : null}</div> : null}{action.state === "uncertain" ? <p className="text-sm">Delivery outcome is unknown. The service will check the original receipt before any retry.</p> : null}{action.receipt ? <div className="space-y-1 text-sm"><p>Delivery confirmed {new Date(action.receipt.acceptedAt).toLocaleString()}</p><p className="break-all text-xs text-muted-foreground">Receipt {action.receipt.id}</p></div> : null}{action.errorCode ? <p className="text-sm text-muted-foreground">{action.errorCode.replaceAll("_", " ").toLowerCase()}</p> : null}</div>;
  })}</section>;
}
