"use client";

import type { Org } from "@/lib/orgs";
import { apiUrl } from "@/lib/server-api";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function WorkspaceSettingsClient({ org, canManage }: { org: Org; canManage: boolean }) {
  const router = useRouter();
  const [name, setName] = useState(org.name);
  const [logo, setLogo] = useState(org.logo || "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  async function save() {
    setSaving(true); setMessage("");
    try {
      const response = await fetch(apiUrl(`/api/orgs/${org.id}`), { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, logo: logo.trim() || null }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Failed to update workspace");
      setMessage("Workspace settings saved."); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Failed to update workspace"); } finally { setSaving(false); }
  }
  return <div className="min-h-screen p-4 sm:p-6 lg:p-8"><div className="mx-auto max-w-3xl space-y-6">
    <header><p className="text-sm text-muted-foreground">Workspace</p><h1 className="mt-1 text-3xl font-semibold text-foreground">Workspace settings</h1><p className="mt-2 text-sm text-muted-foreground">Shared business details for this organization. Personal account settings remain under Profile.</p></header>
    <section className="rounded-xl border border-border bg-card p-6"><h2 className="text-lg font-semibold text-foreground">Business identity</h2>
      {message ? <p className="mt-3 text-sm text-muted-foreground">{message}</p> : null}
      <div className="mt-5 grid gap-4"><label className="text-sm"><span className="text-muted-foreground">Workspace name</span><input disabled={!canManage} value={name} onChange={(event) => setName(event.target.value)} className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-foreground disabled:opacity-60" /></label>
      <label className="text-sm"><span className="text-muted-foreground">Logo URL</span><input disabled={!canManage} value={logo} onChange={(event) => setLogo(event.target.value)} placeholder="https://…" className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-foreground disabled:opacity-60" /></label></div>
      {canManage ? <button type="button" onClick={save} disabled={saving || !name.trim()} className="mt-5 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60">{saving ? "Saving…" : "Save workspace settings"}</button> : <p className="mt-5 text-sm text-muted-foreground">Only workspace owners and admins can change shared settings.</p>}
    </section>
    <section className="rounded-xl border border-border bg-card p-6"><h2 className="text-lg font-semibold text-foreground">Related settings</h2><div className="mt-4 flex flex-wrap gap-3"><Link href="/workspace/profile" className="rounded-md border border-border px-3 py-2 text-sm text-foreground">Personal profile</Link><Link href="/workspace/team" className="rounded-md border border-border px-3 py-2 text-sm text-foreground">Team and invitations</Link></div></section>
  </div></div>;
}
