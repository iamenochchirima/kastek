"use client";

import { useState } from "react";
import { Mail, Plus, RotateCw, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/admin/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

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
    setSaving(true);
    setMessage(null);
    const response = await fetch("/api/core/admin/access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, workspaceName }),
    });
    const data = await response.json().catch(() => ({}));
    setSaving(false);
    if (!response.ok) {
      setMessage(data.error ?? "Unable to provision access.");
      return;
    }
    setName("");
    setEmail("");
    setWorkspaceName("");
    setMessage(`Invitation sent to ${data.invitation.email}.`);
    await refresh();
  }

  async function action(id: string, actionName: "resend" | "revoke") {
    setMessage(null);
    const response = await fetch(`/api/core/admin/access/${id}/${actionName}`, { method: "POST" });
    const data = await response.json().catch(() => ({}));
    setMessage(response.ok ? (actionName === "resend" ? "Invitation resent." : "Invitation revoked.") : (data.error ?? "Unable to update access."));
    if (response.ok) await refresh();
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Invite launch user</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">Creates a workspace and sends an activation link.</p>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={provision} className="grid gap-4 md:grid-cols-3">
            <label className="space-y-1.5 text-xs font-medium text-foreground">
              Name
              <Input required value={name} onChange={(event) => setName(event.target.value)} placeholder="Jane Doe" />
            </label>
            <label className="space-y-1.5 text-xs font-medium text-foreground">
              Email
              <Input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="jane@company.com" />
            </label>
            <label className="space-y-1.5 text-xs font-medium text-foreground">
              Workspace name
              <Input required value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} placeholder="Acme Studio" />
            </label>
            <div className="md:col-span-3">
              <Button type="submit" disabled={saving} aria-busy={saving}>
                <Plus className="size-4" />
                {saving ? "Sending…" : "Create workspace and send invite"}
              </Button>
            </div>
          </form>
          {message ? <p role="status" className="mt-4 text-sm text-muted-foreground">{message}</p> : null}
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader>
          <div>
            <CardTitle>Launch access</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">Users provisioned through the internal release-access flow.</p>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Workspace</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {access.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell><div className="font-medium">{entry.name ?? "Pending user"}</div><div className="text-xs text-muted-foreground">{entry.email}</div></TableCell>
                  <TableCell>{entry.workspaceName}</TableCell>
                  <TableCell><StatusBadge value={entry.status} /></TableCell>
                  <TableCell className="text-muted-foreground">{new Date(entry.expiresAt).toLocaleDateString()}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      {entry.status !== "active" ? <Button variant="secondary" size="sm" onClick={() => void action(entry.id, "resend")}><RotateCw className="size-3.5" />Resend</Button> : null}
                      {entry.status === "pending" ? <Button variant="secondary" size="sm" onClick={() => void action(entry.id, "revoke")}><ShieldX className="size-3.5" />Revoke</Button> : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {!access.length ? <TableRow><TableCell colSpan={5} className="py-10 text-center text-muted-foreground"><Mail className="mx-auto mb-2 size-5" />No launch users have been invited yet.</TableCell></TableRow> : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
