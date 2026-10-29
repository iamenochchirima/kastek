import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { Notification01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { api, message, organizationPath } from "./api";
import "./inbox-alerts.css";

type SupportAlert = {
  id: string; conversationId: string; kind: string; createdAt: string; acknowledgedAt: string | null;
  state: string; assigneeAccountId: string | null; firstHumanReplyAt: string | null; href: string;
};
type AlertPage = { unread: number; alerts: SupportAlert[] };

export function useInboxAlerts(organizationId: string, accountId: string) {
  const [data, setData] = useState<AlertPage | null>(null);
  const [error, setError] = useState("");
  const generation = useRef(0), request = useRef(0);
  const base = organizationId ? `${organizationPath(organizationId)}/inbox-alerts` : "";
  const refresh = useCallback(async () => {
    if (!base || !accountId) return;
    const current = generation.current, sequence = ++request.current;
    try { const result = await api<AlertPage>(base); if (current === generation.current && sequence === request.current) { setData(result); setError(""); } }
    catch (error) { if (current === generation.current && sequence === request.current) setError(message(error)); }
  }, [base, accountId]);
  useEffect(() => {
    const activeGeneration = ++generation.current; setData(null); setError("");
    let running = false;
    const poll = async () => { if (running) return; running = true; try { await refresh(); } finally { running = false; } };
    void poll();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void poll(); }, 10000);
    const visible = () => { if (document.visibilityState === "visible") void poll(); };
    document.addEventListener("visibilitychange", visible);
    return () => { generation.current = activeGeneration + 1; window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);
  async function acknowledge(id: string) {
    const current = generation.current;
    const result = await api<{ acknowledgedAt: string }>(`${base}/${encodeURIComponent(id)}/acknowledge`, {});
    if (current !== generation.current) return false;
    request.current++;
    setData(previous => previous ? { unread: Math.max(0, previous.unread - (previous.alerts.some(alert => alert.id === id && !alert.acknowledgedAt) ? 1 : 0)), alerts: previous.alerts.map(alert => alert.id === id ? { ...alert, acknowledgedAt: result.acknowledgedAt } : alert) } : previous);
    return true;
  }
  return { data, error, refresh, acknowledge };
}

export function InboxAlertsButton({ unread, onClick, mobile = false }: { unread: number; onClick(): void; mobile?: boolean }) {
  return <Button variant="ghost" className={mobile ? "inbox-alert-trigger inbox-alert-trigger-mobile" : "inbox-alert-trigger workspace-nav-link"} aria-label={unread ? `Support alerts, ${unread} unread` : "Support alerts"} title="Support alerts" onClick={onClick}>
    <HugeiconsIcon icon={Notification01Icon} size={18} aria-hidden="true" /><span className="inbox-alert-trigger-label">Support alerts</span>{unread > 0 ? <b className="inbox-alert-count" aria-hidden="true">{unread > 99 ? "99+" : unread}</b> : null}
  </Button>;
}

function alertStatus(alert: SupportAlert) {
  if (alert.state === "resolved") return "Resolved";
  if (alert.firstHumanReplyAt) return "Human replied";
  if (alert.state === "automation_active") return "With agent";
  return alert.assigneeAccountId ? "Awaiting reply" : "Unassigned";
}

export function InboxAlertsDialog({ open, onOpenChange, controller, restoreFocus }: { open: boolean; onOpenChange(open: boolean): void; controller: ReturnType<typeof useInboxAlerts>; restoreFocus(): void }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null), [actionError, setActionError] = useState("");
  const { data, error, refresh, acknowledge } = controller;
  useEffect(() => { if (open) { setActionError(""); void refresh(); } }, [open, refresh]);
  async function markRead(alert: SupportAlert, visit: boolean) {
    setBusy(alert.id); setActionError("");
    try {
      if (!alert.acknowledgedAt && !await acknowledge(alert.id)) return;
      if (visit) { onOpenChange(false); navigate(`/app/inbox?conversation=${encodeURIComponent(alert.conversationId)}`); }
    } catch (error) { setActionError(message(error)); } finally { setBusy(null); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="inbox-alert-dialog" onCloseAutoFocus={event => { event.preventDefault(); restoreFocus(); }}><DialogHeader><DialogTitle>Support alerts</DialogTitle><DialogDescription className="sr-only">Human support requests and delayed replies.</DialogDescription></DialogHeader>
    {error || actionError ? <div className="space-y-2"><p role="alert" className="text-sm text-destructive">{actionError || error}</p><Button size="sm" variant="outline" onClick={() => void refresh()}>Retry</Button></div> : null}
    {!data && !error ? <div aria-label="Loading support alerts" className="space-y-3"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div> : data?.alerts.length ? <ul className="inbox-alert-list">{data.alerts.map(alert => <li key={alert.id} className={alert.acknowledgedAt ? "" : "is-unread"}>
      <button type="button" className="inbox-alert-open" disabled={busy !== null} onClick={() => void markRead(alert, true)}><span className="inbox-alert-copy"><strong>{alert.kind === "handoff_requested" ? "Human support requested" : alert.kind === "unassigned" ? "Request needs an assignee" : "Customer awaiting a reply"}</strong><span>{alertStatus(alert)} <span aria-hidden="true">·</span> <time dateTime={alert.createdAt}>{new Date(alert.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></span></span><HugeiconsIcon icon={ArrowRight01Icon} size={16} aria-hidden="true" /><span className="sr-only">Open conversation</span></button>
      {!alert.acknowledgedAt ? <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void markRead(alert, false)}>{busy === alert.id ? "Saving…" : "Mark read"}</Button> : null}
    </li>)}</ul> : data ? <p className="py-8 text-center text-sm text-muted-foreground">No support alerts</p> : null}
  </DialogContent></Dialog>;
}
