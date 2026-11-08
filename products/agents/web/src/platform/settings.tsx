import { useState } from "react";
import { PiSignOut as LogOut, PiMoon as Moon, PiSun as Sun, PiMonitor as Monitor, PiUserCircle as UserRound, PiBuildings as Building2, PiPalette as Palette } from "react-icons/pi";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { bootstrapAppearance } from "@/components/theme-script";
import { APPEARANCE_STORAGE_KEYS, type ThemeMode } from "@/lib/appearance-contract";
import { ErrorMessage, useWorkspace } from "./shell";
import { message } from "./api";
import "./management.css";
import "./workspace-surfaces.css";
import { ModelProvidersSettings } from "./model-providers";
import { McpAccess } from "./mcp-access";
import { BillingSettings } from "./billing-settings";

export function SettingsPage() {
  const { session, organizationId, createWorkspace, selectWorkspace, logout } = useWorkspace();
  const workspace = session.organizations.find(item => item.id === organizationId);
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const stored = document.documentElement.dataset.themeMode;
    return stored === "light" || stored === "dark" ? stored : "system";
  });
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  function changeTheme(value: ThemeMode) {
    try {
      localStorage.setItem(APPEARANCE_STORAGE_KEYS.theme, value);
      bootstrapAppearance(); setTheme(value);
    } catch { toast.error("Appearance could not be saved"); }
  }
  async function signOut() {
    setBusy(true); setError("");
    try { await logout(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }
  return <section className="management-page max-w-4xl">
    <header className="management-header"><h1>Settings</h1></header>
    <ErrorMessage value={error} />
    <section className="settings-group" aria-labelledby="settings-account">
      <h2 id="settings-account" className="settings-heading"><UserRound size={16} strokeWidth={1.7} aria-hidden="true" />Account</h2>
      <div className="space-y-4">
        <div><p className="settings-label">Name</p><p className="settings-value">{session.account.displayName || session.account.email}</p></div>
        <div><p className="settings-label">Email</p><p className="settings-value">{session.account.email}</p></div>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void signOut()}><LogOut className="size-4" />{busy ? "Signing out…" : "Sign out"}</Button>
      </div>
    </section>
    <section className="settings-group" aria-labelledby="settings-workspace">
      <h2 id="settings-workspace" className="settings-heading"><Building2 size={16} strokeWidth={1.7} aria-hidden="true" />Workspace</h2>
      <div className="space-y-4">
        <label className="block space-y-2 text-sm">Current workspace<select className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value={organizationId} onChange={event => selectWorkspace(event.target.value)}>{session.organizations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {workspace ? <p className="text-xs capitalize text-muted-foreground">{workspace.role}</p> : null}
        <Button variant="outline" size="sm" onClick={createWorkspace}>Create workspace</Button>
      </div>
    </section>
    <ModelProvidersSettings key={organizationId} organizationId={organizationId} owner={workspace?.role === "owner"} />
    <BillingSettings key={`billing-${organizationId}`} organizationId={organizationId} />
    <McpAccess key={organizationId} organizationId={organizationId} />
    <section className="settings-group" aria-labelledby="settings-appearance">
      <h2 id="settings-appearance" className="settings-heading"><Palette size={16} strokeWidth={1.7} aria-hidden="true" />Appearance</h2>
      <fieldset className="space-y-3"><legend className="mb-3 text-sm">Theme</legend><div className="flex flex-wrap gap-2">{([{value:"light",label:"Light",Icon:Sun},{value:"dark",label:"Dark",Icon:Moon},{value:"system",label:"System",Icon:Monitor}] as const).map(({value,label,Icon}) => <Button key={value} size="sm" variant={theme === value ? "secondary" : "outline"} aria-pressed={theme === value} onClick={() => changeTheme(value)}><Icon className="size-4" />{label}</Button>)}</div></fieldset>
    </section>
  </section>;
}
