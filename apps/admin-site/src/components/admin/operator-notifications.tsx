"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

type Notification = { id: string; eventKey: string; severity: string; kind: string; title: string; body: string; status: string; createdAt: string };

const runbookLabels: Record<string, string> = {
  provider_outage: "Provider or model outage",
  model_outage: "Provider or model outage",
  queue_backlog: "Queue backlog or stuck run",
  stuck_run: "Queue backlog or stuck run",
  duplicate_effect: "Duplicate or ambiguous effect",
  webhook_storm: "Webhook or delivery storm",
  credential_compromise: "Credential compromise or data access",
  data_access: "Credential compromise or data access",
};

export function OperatorNotifications({ initialNotifications }: { initialNotifications: Notification[] }) {
  const [notifications, setNotifications] = useState(initialNotifications);
  async function acknowledge(id: string) {
    const response = await fetch(`/api/operations/notifications/${encodeURIComponent(id)}/acknowledge`, { method: "POST" });
    if (!response.ok) return;
    setNotifications((current) => current.map((notification) => notification.id === id ? { ...notification, status: "acknowledged" } : notification));
  }
  return <section className="v-card overflow-hidden"><div className="border-b border-border px-5 py-4"><h2 className="text-sm font-semibold text-foreground">Operator notifications</h2><p className="mt-1 text-xs text-muted-foreground">Generated from rebuildable alert projections and safe to acknowledge without exposing payloads.</p></div>{notifications.length === 0 ? <p className="px-5 py-8 text-sm text-muted-foreground">No operator notifications.</p> : <div className="divide-y divide-border">{notifications.map((notification) => <div key={notification.id} className="flex items-start justify-between gap-3 px-5 py-3"><div><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium text-foreground">{notification.title}</p><span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{notification.severity}</span></div><p className="mt-1 text-xs text-muted-foreground">{notification.body} · {new Date(notification.createdAt).toLocaleString()}</p><p className="mt-1 text-[11px] text-muted-foreground">Runbook: {runbookLabels[notification.kind] ?? "Incident response"}</p></div>{notification.status === "unread" ? <Button variant="link" size="sm" onClick={() => void acknowledge(notification.id)}>Acknowledge</Button> : <span className="text-xs text-muted-foreground">Acknowledged</span>}</div>)}</div>}</section>;
}
