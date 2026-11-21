import { useEffect, useState } from "react";
import {
  PiSignOut as LogOut,
  PiMoon as Moon,
  PiSun as Sun,
  PiMonitor as Monitor,
  PiUserCircle as UserRound,
  PiBuildings as Building2,
  PiPalette as Palette,
  PiWallet as Wallet,
  PiChartBar as ChartBar,
  PiCpu as Cpu,
  PiPlugsConnected as Plugs,
  PiUsersThree as Users,
} from "react-icons/pi";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { bootstrapAppearance } from "@/components/theme-script";
import { APPEARANCE_STORAGE_KEYS, type ThemeMode } from "@/lib/appearance-contract";
import { ErrorMessage, useWorkspace } from "./shell";
import { hasPermission, message, type Organization } from "./api";
import "./management.css";
import "./workspace-surfaces.css";
import { ModelProvidersSettings } from "./model-providers";
import { MembersSettings } from "./members-settings";
import { McpAccess } from "./mcp-access";
import { BillingSettings, UsageSettings } from "./billing-settings";
import { ApplicationsSettings } from "./applications-settings";

type SettingsTab =
  | "account"
  | "workspace"
  | "members"
  | "billing"
  | "usage"
  | "models"
  | "mcp"
  | "applications"
  | "appearance";

const SETTINGS_LINKS = [
  { id: "account", label: "Account", icon: UserRound },
  { id: "workspace", label: "Workspace", icon: Building2 },
  { id: "members", label: "Members", icon: Users },
  { id: "billing", label: "Billing", icon: Wallet },
  { id: "usage", label: "Usage", icon: ChartBar },
  { id: "models", label: "Model providers", icon: Cpu },
  { id: "mcp", label: "MCP access", icon: Plugs },
  { id: "applications", label: "Applications", icon: Plugs },
  { id: "appearance", label: "Appearance", icon: Palette },
] as const satisfies ReadonlyArray<{ id: SettingsTab; label: string; icon: typeof UserRound }>;

function tabAllowed(id: SettingsTab, organization: Organization | undefined): boolean {
  if (id === "billing" || id === "usage") return hasPermission(organization, "billing.manage");
  if (id === "models" || id === "applications") return hasPermission(organization, "credentials.manage");
  return true;
}

function initialTab(): SettingsTab {
  const section = new URLSearchParams(window.location.search).get("section");
  return SETTINGS_LINKS.some((item) => item.id === section)
    ? (section as SettingsTab)
    : "account";
}

export function SettingsPage() {
  const { session, organizationId, createWorkspace, selectWorkspace, logout } = useWorkspace();
  const workspace = session.organizations.find((item) => item.id === organizationId);
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const stored = document.documentElement.dataset.themeMode;
    return stored === "light" || stored === "dark" ? stored : "system";
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const allowedLinks = SETTINGS_LINKS.filter(({ id }) => tabAllowed(id, workspace));

  useEffect(() => {
    if (tabAllowed(tab, workspace)) return;
    setTab("account");
    window.history.replaceState({}, "", "/app/settings?section=account");
  }, [tab, workspace]);

  function selectTab(next: SettingsTab) {
    setTab(next);
    window.history.replaceState({}, "", `/app/settings?section=${next}`);
  }

  function changeTheme(value: ThemeMode) {
    try {
      localStorage.setItem(APPEARANCE_STORAGE_KEYS.theme, value);
      bootstrapAppearance();
      setTheme(value);
    } catch {
      toast.error("Appearance could not be saved");
    }
  }

  async function signOut() {
    setBusy(true);
    setError("");
    try {
      await logout();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="management-page max-w-6xl">
      <header className="management-header">
        <h1>Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Manage your account, workspace, billing and access.</p>
      </header>
      <ErrorMessage value={error} />

      <div className="mt-6 flex flex-col gap-6 lg:flex-row lg:items-start">
        <nav
          aria-label="Settings sections"
          className="-mx-4 flex shrink-0 gap-1 overflow-x-auto px-4 pb-1 lg:mx-0 lg:w-[200px] lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0"
        >
          {allowedLinks.map(({ id, label, icon: Icon }) => {
            const active = tab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => selectTab(id)}
                aria-current={active ? "page" : undefined}
                className={`flex h-10 shrink-0 items-center gap-2.5 whitespace-nowrap rounded-md px-3 text-left text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  active
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                }`}
              >
                <Icon size={16} />
                {label}
              </button>
            );
          })}
        </nav>

        <div className="min-w-0 w-full max-w-[1080px] flex-1">
          {tab === "account" ? (
            <section className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]">
              <h2 className="text-base font-semibold text-foreground">Account</h2>
              <p className="mt-1 text-sm text-muted-foreground">Your KasiTek identity.</p>
              <div className="mt-5 grid max-w-xl gap-4 sm:grid-cols-2">
                <div>
                  <p className="settings-label">Name</p>
                  <p className="settings-value">{session.account.displayName || session.account.email}</p>
                </div>
                <div>
                  <p className="settings-label">Email</p>
                  <p className="settings-value">{session.account.email}</p>
                </div>
              </div>
              <Button variant="outline" size="sm" className="mt-5" disabled={busy} onClick={() => void signOut()}>
                <LogOut className="size-4" />
                {busy ? "Signing out…" : "Sign out"}
              </Button>
            </section>
          ) : null}

          {tab === "workspace" ? (
            <section className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]">
              <h2 className="text-base font-semibold text-foreground">Workspace</h2>
              <p className="mt-1 text-sm text-muted-foreground">The workspace you are currently managing.</p>
              <div className="mt-5 grid max-w-xl gap-4">
                <label className="block space-y-2 text-sm">
                  Current workspace
                  <select
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                    value={organizationId}
                    onChange={(event) => selectWorkspace(event.target.value)}
                  >
                    {session.organizations.map((item) => (
                      <option key={item.id} value={item.id}>{item.name}</option>
                    ))}
                  </select>
                </label>
                {workspace ? <p className="text-xs capitalize text-muted-foreground">{workspace.role}</p> : null}
                <div>
                  <Button variant="outline" size="sm" onClick={createWorkspace}>Create workspace</Button>
                </div>
              </div>
            </section>
          ) : null}

          {tab === "members" ? (
            <MembersSettings
              key={`members-${organizationId}`}
              organizationId={organizationId}
              currentAccountId={session.account.id}
            />
          ) : null}

          {tab === "billing" ? (
            <BillingSettings key={`billing-${organizationId}`} organizationId={organizationId} />
          ) : null}

          {tab === "usage" ? (
            <UsageSettings key={`usage-${organizationId}`} organizationId={organizationId} />
          ) : null}

          {tab === "models" ? (
            <div className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]">
              <ModelProvidersSettings organizationId={organizationId} owner={workspace?.role === "owner"} />
            </div>
          ) : null}

          {tab === "mcp" ? (
            <div className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]">
              <McpAccess organizationId={organizationId} />
            </div>
          ) : null}

          {tab === "applications" ? <div className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]"><ApplicationsSettings key={organizationId} organizationId={organizationId} /></div> : null}

          {tab === "appearance" ? (
            <section className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]">
              <h2 className="text-base font-semibold text-foreground">Appearance</h2>
              <p className="mt-1 text-sm text-muted-foreground">Theme for this browser.</p>
              <fieldset className="mt-5 space-y-3">
                <legend className="sr-only">Theme</legend>
                <div className="flex flex-wrap gap-2">
                  {([
                    { value: "light", label: "Light", Icon: Sun },
                    { value: "dark", label: "Dark", Icon: Moon },
                    { value: "system", label: "System", Icon: Monitor },
                  ] as const).map(({ value, label, Icon }) => (
                    <Button
                      key={value}
                      size="sm"
                      variant={theme === value ? "secondary" : "outline"}
                      aria-pressed={theme === value}
                      onClick={() => changeTheme(value)}
                    >
                      <Icon className="size-4" />
                      {label}
                    </Button>
                  ))}
                </div>
              </fieldset>
            </section>
          ) : null}
        </div>
      </div>
    </section>
  );
}
