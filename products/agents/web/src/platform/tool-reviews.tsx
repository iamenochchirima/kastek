import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { api, ApiError, message, organizationPath, type ToolReview } from "./api";
import { ErrorMessage, useWorkspace } from "./shell";

const reviewLabel = (state: ToolReview["state"]) => ({ pending: "Approval required", approved: "Approved", rejected: "Rejected", claimed: "In progress", completed: "Completed", uncertain: "Outcome unknown", expired: "Expired", invalidated: "No longer valid" })[state];
const reviewKey = (review: ToolReview) => `${review.id}:${review.requestDigest}`;
function valueSummary(value: unknown, depth = 0): string {
  if (depth > 8) return "See exact data";
  if (value === null) return "None";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(entry => valueSummary(entry, depth + 1)).join(", ") || "None";
  if (typeof value === "object") return Object.entries(value).map(([name, entry]) => `${name.replaceAll("_", " ")}: ${valueSummary(entry, depth + 1)}`).join("; ") || "None";
  return String(value);
}

export function ToolReviews({ taskId, awaiting, available, onRefresh }: { taskId: string; awaiting: boolean; available: boolean; onRefresh?: () => void }) {
  const { organizationId, session } = useWorkspace();
  const { confirm } = useConfirmationDialog();
  const path = `${organizationPath(organizationId)}/tasks/${encodeURIComponent(taskId)}/tool-reviews`;
  const [reviews, setReviews] = useState<ToolReview[]>([]), [error, setError] = useState("");
  const [busy, setBusy] = useState(""), [generation, setGeneration] = useState(0);
  const [blocked, setBlocked] = useState<string[]>([]);
  const latest = useRef(reviews); latest.current = reviews;
  const mounted = useRef(true), requestLock = useRef(false);
  const refreshParent = useRef(onRefresh); refreshParent.current = onRefresh;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!awaiting && !available && !latest.current.length) return;
    let closed = false, unknownPolls = 0;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await api<{ reviews: ToolReview[] }>(path);
        if (closed) return;
        const scoped = result.reviews.filter(review => review.taskId === taskId && review.reviewerAccountId === session.account.id);
        setReviews(scoped);
        const unresolved = scoped.some(review => ["pending", "approved", "claimed"].includes(review.state) && (review.state !== "pending" || Date.parse(review.expiresAt) > Date.now()));
        const uncertain = scoped.some(review => review.state === "uncertain");
        if (!unresolved && uncertain && ++unknownPolls >= 3) return;
        if (!unresolved && !uncertain && !awaiting) return;
      } catch (e) {
        if (closed) return;
        setError(message(e));
        if (e instanceof ApiError && [401, 403, 404].includes(e.status)) { setReviews([]); refreshParent.current?.(); return; }
        return;
      }
      timer = setTimeout(() => void poll(), 1200);
    }
    void poll(); return () => { closed = true; clearTimeout(timer); };
  }, [path, taskId, session.account.id, awaiting, available, generation]);

  async function decide(review: ToolReview, decision: "approve" | "reject") {
    if (requestLock.current || review.state !== "pending" || Date.parse(review.expiresAt) <= Date.now() || review.reviewerAccountId !== session.account.id || blocked.includes(reviewKey(review))) return;
    requestLock.current = true;
    if (decision === "approve") {
      const accepted = await confirm({ title: "Approve this action?", description: `${review.operationName ?? "This action"} will run using ${review.connectionName ?? "the connected service"} with the data shown in this review.`, confirmLabel: "Approve action" });
      if (!accepted || !mounted.current || Date.parse(review.expiresAt) <= Date.now() || !latest.current.some(current => reviewKey(current) === reviewKey(review) && current.state === "pending")) { requestLock.current = false; return; }
    }
    setBusy(review.id); setError("");
    try {
      const result = await api<{ review: ToolReview }>(`${path}/${encodeURIComponent(review.id)}/decision`, { decision, requestDigest: review.requestDigest });
      if (!mounted.current) return;
      setReviews(current => current.map(item => item.id === result.review.id ? result.review : item));
      setGeneration(value => value + 1); refreshParent.current?.();
    } catch (e) {
      if (!mounted.current) return;
      setError(message(e));
      if (e instanceof ApiError && [401, 403, 404].includes(e.status)) { setReviews([]); refreshParent.current?.(); }
      else if (e instanceof ApiError && [409, 410, 422].includes(e.status)) { setBlocked(current => [...current, reviewKey(review)]); setGeneration(value => value + 1); refreshParent.current?.(); }
    } finally { requestLock.current = false; if (mounted.current) setBusy(""); }
  }
  if (!reviews.length && !error) return null;
  return <section aria-label="Tool approvals" className="space-y-4 border-t border-border pt-6"><h3 className="font-medium">Tool approvals</h3><ErrorMessage value={error} />{reviews.map(review => {
    const expired = review.state === "pending" && Date.parse(review.expiresAt) <= Date.now();
    const unavailable = blocked.includes(reviewKey(review));
    const reviewer = review.reviewerAccountId === session.account.id;
    return <article key={review.id} className="space-y-4 rounded-md border border-border p-4"><div className="space-y-2"><h4 className="break-words text-sm font-medium">{review.operationName?.replaceAll("_", " ") ?? "Tool action"}</h4>{review.connectionName ? <p className="break-words text-sm">{review.connectionName}</p> : null}{review.destination ? <p className="break-all text-xs text-muted-foreground">{review.destination}</p> : null}<div className="flex flex-wrap items-center gap-3"><span className="task-state shrink-0 whitespace-nowrap" data-state={expired ? "expired" : review.state}>{reviewLabel(expired ? "expired" : review.state)}</span>{review.state === "pending" && !expired ? <p className="text-xs text-muted-foreground">Expires {new Date(review.expiresAt).toLocaleString()}</p> : null}</div></div>
      {review.state === "pending" ? <><dl className="space-y-2 text-sm">{(review.arguments !== null && typeof review.arguments === "object" && !Array.isArray(review.arguments) ? Object.entries(review.arguments) : [["Data", review.arguments] as const]).map(([name, value]) => <div key={name} className="grid min-w-0 gap-1 sm:grid-cols-[minmax(0,140px)_minmax(0,1fr)]"><dt className="break-words text-muted-foreground">{name.replaceAll("_", " ")}</dt><dd className="min-w-0 whitespace-pre-wrap break-words">{valueSummary(value)}</dd></div>)}</dl><div className="flex flex-wrap gap-2"><Button type="button" disabled={Boolean(busy) || expired || unavailable || !reviewer} onClick={() => void decide(review, "approve")}>{busy === review.id ? "Saving…" : "Approve action"}</Button><Button type="button" variant="outline" disabled={Boolean(busy) || expired || unavailable || !reviewer} onClick={() => void decide(review, "reject")}>Reject action</Button></div>{!reviewer ? <p className="text-sm text-muted-foreground">Awaiting the assigned reviewer.</p> : null}{expired ? <p className="text-sm text-muted-foreground">This review has expired. Request a new review before continuing.</p> : null}{unavailable ? <p className="text-sm text-muted-foreground">The action changed. Refresh to review its current status.</p> : null}</> : null}
      <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Exact data</summary><pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs leading-5">{JSON.stringify(review.arguments, null, 2)}</pre></details>
      {review.state === "uncertain" ? <p className="text-sm text-muted-foreground">The outcome is unknown. Check the connected service before requesting another action.</p> : null}{review.state === "invalidated" ? <p className="text-sm text-muted-foreground">The action or its permissions changed. A new review is required.</p> : null}
    </article>;
  })}<Button type="button" size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => { setError(""); setGeneration(value => value + 1); onRefresh?.(); }}>Refresh approvals</Button></section>;
}
