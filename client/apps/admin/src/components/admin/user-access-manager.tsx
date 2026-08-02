"use client";

import { useState } from "react";
import { Mail, Plus, RotateCw, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";

export type LaunchAccess = {
  id: string;
  name: string | null;
  email: string;
  workspaceId: string;
  workspaceName: string;
  role: string;
  status: "pending" | "active" | "expired" | "revoked";
  expiresAt: string;
  createdAt: string;
};

const statusClass: Record<LaunchAccess["status"], string> = {
  pending: "bg-status-attention-soft text-status-attention",
  active: "bg-status-success-soft text-status-success",
  expired: "bg-secondary text-muted-foreground",
  revoked: "bg-status-danger-soft text-destructive",
};

export function UserAccessManager({ initialAccess }: { initialAccess: LaunchAccess[] }) {
  const [access, setAccess] = useState(initialAccess);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function refresh() {
    const response = await fetch("/api/core/admin/access", { cache: "no-store" });
    if (response.ok) setAccess((await response.json()).access ?? []);
  }

  async function provision(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true); setMessage(null);
    const response = await fetch("/api/core/admin/access", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, email, workspaceName }) });
    const data = await response.json().catch(() => ({}));
    setSaving(false);
    if (!response.ok) { setMessage(data.error ?? "Unable to provision access."); return; }
    setName(""); setEmail(""); setWorkspaceName(""); setMessage(`Invitation sent to ${data.invitation.email}.`); await refresh();
  }

  async function action(id: string, name: "resend" | "revoke") {
    setMessage(null);
    const response = await fetch(`/api/core/admin/access/${id}/${name}`, { method: "POST" });
    const data = await response.json().catch(() => ({}));
    setMessage(response.ok ? (name === "resend" ? "Invitation resent." : "Invitation revoked.") : (data.error ?? "Unable to update access."));
    if (response.ok) await refresh();
  }

  return <div className="space-y-6">
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="mb-5"><h2 className="text-base font-semibold">Invite launch user</h2><p className="mt-1 text-sm text-muted-foreground">Creates their first workspace and sends the secure account-activation link.</p></div>
      <form onSubmit={provision} className="grid gap-3 md:grid-cols-3">
        <label className="text-sm font-medium">Name<input required value={name} onChange={(event) => setName(event.target.value)} className="mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2" placeholder="Jane Doe" /></label>
        <label className="text-sm font-medium">Email<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} className="mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2" placeholder="jane@company.com" /></label>
        <label className="text-sm font-medium">Workspace name<input required value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} className="mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2" placeholder="Acme Studio" /></label>
        <div className="md:col-span-3"><Button type="submit" disabled={saving}><Plus className="mr-2 size-4" />{saving ? "Sending…" : "Create workspace and send invite"}</Button></div>
      </form>
      {message ? <p className="mt-4 text-sm text-muted-foreground">{message}</p> : null}
    </section>
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b border-border px-5 py-4"><h2 className="font-semibold">Launch access</h2><p className="mt-1 text-sm text-muted-foreground">Users provisioned through the internal release-access flow.</p></div>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-secondary/40 text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-5 py-3">User</th><th className="px-5 py-3">Workspace</th><th className="px-5 py-3">Status</th><th className="px-5 py-3">Expires</th><th className="px-5 py-3 text-right">Actions</th></tr></thead><tbody className="divide-y divide-border">
        {access.map((entry) => <tr key={entry.id}><td className="px-5 py-4"><div className="font-medium">{entry.name ?? "Pending user"}</div><div className="text-xs text-muted-foreground">{entry.email}</div></td><td className="px-5 py-4">{entry.workspaceName}</td><td className="px-5 py-4"><span className={`rounded-full px-2.5 py-1 text-xs font-medium capitalize ${statusClass[entry.status]}`}>{entry.status}</span></td><td className="px-5 py-4 text-muted-foreground">{new Date(entry.expiresAt).toLocaleDateString()}</td><td className="px-5 py-4"><div className="flex justify-end gap-2">{entry.status !== "active" ? <Button variant="secondary" size="sm" onClick={() => void action(entry.id, "resend")}><RotateCw className="mr-1.5 size-3.5" />Resend</Button> : null}{entry.status === "pending" ? <Button variant="secondary" size="sm" onClick={() => void action(entry.id, "revoke")}><ShieldX className="mr-1.5 size-3.5" />Revoke</Button> : null}</div></td></tr>)}
        {!access.length ? <tr><td colSpan={5} className="px-5 py-10 text-center text-muted-foreground"><Mail className="mx-auto mb-2 size-5" />No launch users have been invited yet.</td></tr> : null}
      </tbody></table></div>
    </section>
  </div>;
}
