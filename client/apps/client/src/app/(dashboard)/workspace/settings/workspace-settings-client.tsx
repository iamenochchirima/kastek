"use client";

import type { Org } from "@/lib/orgs";
import { apiUrl } from "@/lib/server-api";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "@/components/ui/page-header";

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
      toast.success("Settings saved"); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Failed to update workspace"); } finally { setSaving(false); }
  }
  return <div className="min-h-screen px-4 py-6 lg:px-6"><div className="mx-auto max-w-[1440px] space-y-6">
    <PageHeader><PageHeaderContent><PageHeaderDescription>Workspace</PageHeaderDescription><PageHeaderTitle>Workspace settings</PageHeaderTitle></PageHeaderContent></PageHeader>
    <section className="rounded-xl border border-border bg-card p-6"><h2 className="text-lg font-semibold text-foreground">Business identity</h2>
      {message ? <p className="mt-3 text-sm text-destructive" role="alert">{message}</p> : null}
      <div className="mt-5 grid max-w-xl gap-4"><label className="text-sm"><span className="text-muted-foreground">Workspace name</span><Input disabled={!canManage} value={name} onChange={(event) => setName(event.target.value)} className="mt-2" /></label>
      <label className="text-sm"><span className="text-muted-foreground">Logo URL</span><Input disabled={!canManage} value={logo} onChange={(event) => setLogo(event.target.value)} placeholder="https://…" className="mt-2" /></label></div>
      {canManage ? <Button type="button" onClick={save} disabled={saving || !name.trim()} className="mt-5">{saving ? "Saving…" : "Save changes"}</Button> : null}
    </section>
    <section className="rounded-xl border border-border bg-card p-6"><h2 className="text-lg font-semibold text-foreground">Related settings</h2><div className="mt-4 flex flex-wrap gap-3"><Button asChild variant="outline"><Link href="/workspace/profile">Profile</Link></Button><Button asChild variant="outline"><Link href="/workspace/team">Team</Link></Button></div></section>
  </div></div>;
}
