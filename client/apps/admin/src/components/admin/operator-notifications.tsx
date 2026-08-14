"use client";

import { useState } from "react";

type Notification = { id: string; eventKey: string; severity: string; kind: string; title: string; body: string; status: string; createdAt: string };

export function OperatorNotifications({ initialNotifications }: { initialNotifications: Notification[] }) {
  const [notifications, setNotifications] = useState(initialNotifications);
  async function acknowledge(id: string) {
    const response = await fetch(`/api/operations/notifications/${encodeURIComponent(id)}/acknowledge`, { method: "POST" });
    if (!response.ok) return;
    setNotifications((current) => current.map((notification) => notification.id === id ? { ...notification, status: "acknowledged" } : notification));
  }
  return <section className="rounded-lg border border-border bg-card"><div className="border-b border-border px-5 py-4"><h2 className="text-sm font-semibold text-foreground">Operator notifications</h2><p className="mt-1 text-xs text-muted-foreground">Generated from rebuildable alert projections and safe to acknowledge without exposing payloads.</p></div>{notifications.length === 0 ? <p className="px-5 py-8 text-sm text-muted-foreground">No operator notifications.</p> : <div className="divide-y divide-border">{notifications.map((notification) => <div key={notification.id} className="flex items-start justify-between gap-3 px-5 py-3"><div><p className="text-sm font-medium text-foreground">{notification.title}</p><p className="mt-1 text-xs text-muted-foreground">{notification.body} · {new Date(notification.createdAt).toLocaleString()}</p></div>{notification.status === "unread" ? <button type="button" onClick={() => void acknowledge(notification.id)} className="text-xs font-medium text-foreground underline">Acknowledge</button> : <span className="text-xs text-muted-foreground">Acknowledged</span>}</div>)}</div>}</section>;
}
