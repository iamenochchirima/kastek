import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { WorkspaceConnection } from "@/lib/connections";
import { apiUrl } from "@/lib/server-api";
import { Link } from "react-router";
import { FaMicrosoft } from "react-icons/fa";
import { Search, Plus, MoreHorizontal, ArrowRight, Clock } from "@/components/ui/interface-icons";
import { PageHeader, PageHeaderTitle, PageHeaderContent, PageHeaderActions } from "@/components/ui/page-header";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import "./connections-workspace.css";
import { getPlatformBrandColor, getPlatformBrandIcon } from "@/lib/platform-icons";
import {
  Bot,
  Check,
  LockKeyhole,
  MessageCircle,
  Radio,
  RefreshCw,
  Unplug,
  X as CloseIcon,
} from "lucide-react";
import { useRevalidator } from "react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";


export type MailboxConnection = {
  id: string; provider: string; emailAddress: string; displayName: string; status: string;
  healthStatus: string; syncStatus: string; inboxStatus: string; inboundStatus: string; outboundStatus: string;
};
const providerPurposes: Record<string, string> = { WHATSAPP: "Customer messages", FACEBOOK: "Pages and messages", INSTAGRAM: "Messages and publishing", LINKEDIN: "Profiles and company publishing", THREADS: "Social publishing", TIKTOK: "Video publishing", X: "Posts and replies", BLUESKY: "Social publishing" };
function MailBrand({ provider }: { provider: string }) {
  if (provider === "google") return <img src="/images/integrations/google-gmail.svg" width={28} height={28} alt="" />;
  return <FaMicrosoft className="size-7 text-blue-600" />;
}

const WHATSAPP_SIGNUP_STATUS_EVENT = "kasitek:whatsapp-embedded-signup-status";

const WhatsAppBrandIcon = getPlatformBrandIcon("WHATSAPP") ?? MessageCircle;
const FacebookBrandIcon = getPlatformBrandIcon("FACEBOOK") ?? MessageCircle;
const InstagramBrandIcon = getPlatformBrandIcon("INSTAGRAM") ?? MessageCircle;

const providerDetails = {
  WHATSAPP: {
    label: "WhatsApp",
    availableLabel: "Available to connect",
    icon: WhatsAppBrandIcon,
    iconClass: getPlatformBrandColor("WHATSAPP"),
    connectPath: "#whatsapp-setup",
    connectLabel: "Connect",
  },
  FACEBOOK: {
    label: "Facebook",
    availableLabel: "Pages via Meta",
    icon: FacebookBrandIcon,
    iconClass: getPlatformBrandColor("FACEBOOK"),
    connectPath: "/api/social/oauth/meta/start?target=facebook",
    connectLabel: "Add Facebook Pages",
  },
  INSTAGRAM: {
    label: "Instagram",
    availableLabel: "Business and Creator accounts",
    icon: InstagramBrandIcon,
    iconClass: getPlatformBrandColor("INSTAGRAM"),
    connectPath: "/api/social/oauth/instagram/start",
    connectLabel: "Connect Instagram",
  },
  THREADS: {
    label: "Threads",
    availableLabel: "Publish to Threads",
    icon: getPlatformBrandIcon("THREADS") ?? MessageCircle,
    iconClass: getPlatformBrandColor("THREADS"),
    connectPath: "/api/social/oauth/threads/start",
    connectLabel: "Connect",
  },
  TIKTOK: {
    label: "TikTok",
    availableLabel: "Available to connect",
    icon: getPlatformBrandIcon("TIKTOK") ?? MessageCircle,
    iconClass: getPlatformBrandColor("TIKTOK"),
    connectPath: "/api/social/oauth/tiktok/start",
    connectLabel: "Connect",
  },
  BLUESKY: {
    label: "Bluesky",
    availableLabel: "Authorize with Bluesky",
    icon: getPlatformBrandIcon("BLUESKY") ?? MessageCircle,
    iconClass: getPlatformBrandColor("BLUESKY"),
    connectPath: null,
    connectLabel: "Connect",
  },
  LINKEDIN: {
    label: "LinkedIn",
    availableLabel: "Profiles and Pages",
    icon: getPlatformBrandIcon("LINKEDIN") ?? MessageCircle,
    iconClass: getPlatformBrandColor("LINKEDIN"),
    connectPath: "/api/social/oauth/linkedin/start",
    connectLabel: "Connect",
  },
  X: {
    label: "X",
    availableLabel: "Available to connect",
    icon: getPlatformBrandIcon("X") ?? MessageCircle,
    iconClass: getPlatformBrandColor("X"),
    connectPath: "/api/social/oauth/x/start",
    connectLabel: "Connect",
  },
} as const;

const productLabels: Record<string, string> = {
  agents: "Agents",
  inbox: "Inbox",
  reach: "Campaigns",
  social: "Content",
};

const ACCESS_OPTIONS = [
  { key: "MESSAGING_INBOUND", group: "MESSAGING", label: "Receive messages", description: "Let KasiTek receive messages for this account." },
  { key: "MESSAGING_OUTBOUND", group: "MESSAGING", label: "Reply to messages", description: "Let KasiTek send replies from this account." },
  { key: "SOCIAL_PUBLISH", group: "PUBLISHING", label: "Publish content", description: "Create and publish content to this account." },
  { key: "MEDIA_PUBLISH", group: "MEDIA", label: "Use media", description: "Upload and use images or videos in content." },
  { key: "SOCIAL_ANALYTICS", group: "ANALYTICS", label: "View analytics", description: "Read performance and audience metrics." },
  { key: "COMMENTS_MANAGE", group: "COMMUNITY", label: "Manage comments", description: "Read and manage supported comments and interactions." },
  { key: "SOCIAL_POST_DELETE", group: "CONTENT_MANAGEMENT", label: "Delete published content", description: "Delete content published through this account." },
] as const;

const DEFAULT_ACCESS_KEYS = [
  "MESSAGING_INBOUND",
  "MESSAGING_OUTBOUND",
  "SOCIAL_PUBLISH",
  "MEDIA_PUBLISH",
  "SOCIAL_ANALYTICS",
];

const PROVIDER_ACCESS_KEYS: Record<string, string[]> = {
  THREADS: ["SOCIAL_PUBLISH", "MEDIA_PUBLISH", "SOCIAL_ANALYTICS", "COMMENTS_MANAGE", "SOCIAL_POST_DELETE"],
  TIKTOK: ["SOCIAL_PUBLISH", "MEDIA_PUBLISH", "SOCIAL_ANALYTICS"],
  LINKEDIN: ["SOCIAL_PUBLISH", "MEDIA_PUBLISH", "SOCIAL_ANALYTICS", "COMMENTS_MANAGE"],
  X: ["MESSAGING_INBOUND", "MESSAGING_OUTBOUND", "SOCIAL_PUBLISH", "MEDIA_PUBLISH", "SOCIAL_ANALYTICS", "COMMENTS_MANAGE"],
  BLUESKY: ["SOCIAL_PUBLISH", "MEDIA_PUBLISH", "SOCIAL_POST_DELETE"],
};

// Keep LinkedIn's Community Management permissions visible for clarity, but do not allow them
// into OAuth requests until this application has been approved for that product.
const PROVIDER_UNAVAILABLE_ACCESS_KEYS: Record<string, string[]> = {
  LINKEDIN: ["SOCIAL_ANALYTICS", "COMMENTS_MANAGE"],
};

const accessStateLabels: Record<string, string> = {
  GRANTED: "Granted",
  REQUESTABLE: "Not granted",
  NOT_GRANTED: "Not granted",
  UNSUPPORTED: "Unsupported",
  UNKNOWN: "Not verified",
  REQUIRES_PROVIDER_APPROVAL: "Provider approval needed",
};

type InitialAccessRequest = {
  connectionId?: string;
  provider?: string;
  capabilities?: string[];
};

function accessStateClass(state: string) {
  switch (state) {
    case "GRANTED":
      return "border-status-success/30 bg-status-success-soft text-status-success";
    case "REQUESTABLE":
    case "NOT_GRANTED":
      return "border-status-attention/30 bg-status-attention-soft text-status-attention";
    case "UNSUPPORTED":
      return "border-border bg-secondary text-muted-foreground";
    default:
      return "border-status-info/30 bg-status-info-soft text-status-info";
  }
}

function statusPresentation(status: WorkspaceConnection["status"]) {
  switch (status) {
    case "CONNECTED":
      return { label: "Connected", className: "border-status-success/30 bg-status-success-soft text-status-success" };
    case "NEEDS_ATTENTION":
      return { label: "Needs attention", className: "border-status-attention/30 bg-status-attention-soft text-status-attention" };
    case "CONNECTING":
      return { label: "Connecting", className: "border-status-info/30 bg-status-info-soft text-status-info" };
    case "REVOKED":
      return { label: "Revoked", className: "border-destructive/30 bg-destructive/10 text-destructive" };
    default:
      return { label: "Disconnected", className: "border-border bg-secondary text-muted-foreground" };
  }
}

function readableStatus(value: string) {
  return value.toLowerCase().replaceAll("_", " ");
}

function normalizeBlueskyHandle(value: string) {
  const handle = value.trim().replace(/^@/, "");
  return handle && !handle.includes(".") ? `${handle}.bsky.social` : handle;
}

function displayableConnections(connections: WorkspaceConnection[]) {
  return connections.filter((connection) => connection.status !== "DISCONNECTED");
}

type AccessOption = (typeof ACCESS_OPTIONS)[number] & {
  available?: boolean;
  availabilityLabel?: string;
};

function providerAccessIsAvailable(provider: string, key: string) {
  return !(PROVIDER_UNAVAILABLE_ACCESS_KEYS[provider] ?? []).includes(key);
}

function defaultAccessKeysForProvider(provider: string) {
  if (provider === "TIKTOK") return [];
  return DEFAULT_ACCESS_KEYS.filter((key) => providerAccessIsAvailable(provider, key));
}

function AccessSelection({
  value,
  onChange,
  options = ACCESS_OPTIONS,
}: {
  value: string[];
  onChange: (keys: string[]) => void;
  options?: readonly AccessOption[];
}) {
  return (
    <div className="space-y-3 rounded-lg border bg-secondary/20 p-4">
      <div>
        <h3 className="text-sm font-medium">Choose access</h3>
        <p className="mt-1 text-xs text-muted-foreground">You can add more access later from the connection details.</p>
      </div>
      <div className="space-y-1">
        {options.map((option) => {
          const available = option.available !== false;
          const checked = available && value.includes(option.key);
          return (
            <label
              key={option.key}
              className={`flex items-start gap-3 rounded-md p-2 ${available ? "cursor-pointer hover:bg-secondary/60" : "cursor-not-allowed opacity-60"}`}
              title={available ? undefined : option.availabilityLabel ?? "Unavailable"}
            >
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-primary"
                checked={checked}
                disabled={!available}
                onChange={(event) => onChange(event.target.checked
                  ? [...value, option.key]
                  : value.filter((key) => key !== option.key))}
              />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {option.label}
                  {!available ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      <LockKeyhole className="size-3" aria-hidden="true" />
                      {option.availabilityLabel ?? "Unavailable"}
                    </span>
                  ) : null}
                </span>
                <span className="block text-xs text-muted-foreground">{option.description}</span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

export function ConnectionsManager({
  connections,
  loadFailed = false,
  initialAccessRequest,
  emailConnections = [],
  emailLoadFailed = false,
}: {
  connections: WorkspaceConnection[];
  loadFailed?: boolean;
  initialAccessRequest?: InitialAccessRequest;
  emailConnections?: MailboxConnection[];
  emailLoadFailed?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [category, setCategory] = useState("all");
  const [addOpen, setAddOpen] = useState(false);
  const [mailbox, setMailbox] = useState<MailboxConnection | null>(null);
  const revalidator = useRevalidator();
  const { confirm } = useConfirmationDialog();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [selectedConnection, setSelectedConnection] = useState<WorkspaceConnection | null>(null);
  const [connectionPicker, setConnectionPicker] = useState<"FACEBOOK" | "INSTAGRAM" | null>(null);
  const [blueskyOpen, setBlueskyOpen] = useState(false);
  const [blueskyHandle, setBlueskyHandle] = useState("");
  const [instagramConnectPath, setInstagramConnectPath] = useState<string | null>(null);
  const [permissionConnectProvider, setPermissionConnectProvider] = useState<string | null>(null);
  const [selectedAccess, setSelectedAccess] = useState<string[]>(DEFAULT_ACCESS_KEYS);
  const [requestedPermissionKeys, setRequestedPermissionKeys] = useState<string[]>([]);
  const [shownConnections, setShownConnections] = useState(() => displayableConnections(connections));

  useEffect(() => {
    setShownConnections(displayableConnections(connections));
  }, [connections]);

  useEffect(() => {
    function handleWhatsappSignupStatus(event: Event) {
      const detail = (event as CustomEvent<{ kind?: string; message?: string }>).detail;
      if (!detail) return;

      if (detail.kind === "error") {
        setError(detail.message || "WhatsApp connection could not be started.");
      } else if (detail.kind === "clear") {
        setError("");
      }
    }

    window.addEventListener(WHATSAPP_SIGNUP_STATUS_EVENT, handleWhatsappSignupStatus);
    return () => window.removeEventListener(WHATSAPP_SIGNUP_STATUS_EVENT, handleWhatsappSignupStatus);
  }, []);

  useEffect(() => {
    if (!initialAccessRequest?.connectionId && !initialAccessRequest?.provider) return;
    const matching = connections.filter((item) => initialAccessRequest.connectionId
      ? item.id === initialAccessRequest.connectionId
      : item.provider.toLowerCase() === initialAccessRequest.provider?.trim().toLowerCase());
    const connection = matching.length === 1 ? matching[0] : undefined;
    if (!connection) return;
    const requested = new Set(initialAccessRequest.capabilities ?? []);
    setSelectedConnection(connection);
    setRequestedPermissionKeys(
      connection.permissions
        .filter((permission) => permission.requestable && requested.has(permission.key))
        .map((permission) => permission.key),
    );
  }, [connections, initialAccessRequest?.capabilities, initialAccessRequest?.connectionId, initialAccessRequest?.provider]);

  const query = search.trim().toLocaleLowerCase();
  const matchesSearch = (values: (string | null | undefined)[]) => !query || values.some(value => value?.toLocaleLowerCase().includes(query));
  const attention = (status: string) => status === "NEEDS_ATTENTION" || status === "REVOKED";
  const emailStatus = (connection: MailboxConnection) => connection.status === "CONNECTED" && connection.healthStatus !== "HEALTHY" ? "NEEDS_ATTENTION" : connection.status;
  const matchesStatus = (status: string) => statusFilter === "all" || (statusFilter === "connected" ? status === "CONNECTED" : attention(status));
  const filteredConnections = shownConnections.filter(connection => matchesSearch([connection.displayName, connection.handle, connection.provider]) && matchesStatus(connection.status));
  const filteredMailboxes = emailConnections.filter(connection => matchesSearch([connection.displayName, connection.emailAddress, connection.provider]) && matchesStatus(emailStatus(connection)));
  const statuses = [...shownConnections.map(connection => connection.status), ...emailConnections.map(emailStatus)];
  const counts = { all: statuses.length, connected: statuses.filter(status => status === "CONNECTED").length, attention: statuses.filter(attention).length };
  const catalogue = Object.entries(providerDetails).filter(([provider, detail]) => matchesSearch([provider, detail.label]) && (category === "all" || category === "messaging" && ["WHATSAPP", "FACEBOOK", "INSTAGRAM", "X"].includes(provider) || category === "publishing" && provider !== "WHATSAPP"));

  function connectProvider(provider: string) {
    setAddOpen(false);
    if (provider === "WHATSAPP") { beginWhatsappEmbeddedSignup(); return; }
    if (provider === "FACEBOOK" || provider === "INSTAGRAM") { setSelectedAccess(DEFAULT_ACCESS_KEYS); setConnectionPicker(provider); return; }
    if (provider === "BLUESKY") { setSelectedAccess(DEFAULT_ACCESS_KEYS); setBlueskyOpen(true); return; }
    setSelectedAccess(defaultAccessKeysForProvider(provider)); setPermissionConnectProvider(provider);
  }

  async function connectEmail(provider: "google" | "microsoft") {
    setPending(`email:${provider}`); setError("");
    try {
      const response = await fetch(apiUrl(`/api/email/oauth/${provider}/start?returnTo=/connections`), { credentials: "include", cache: "no-store" });
      const body = await response.json().catch(() => ({})) as { authorizationUrl?: string; error?: string };
      if (!response.ok || !body.authorizationUrl) throw new Error(body.error || "Unable to connect email");
      window.location.assign(body.authorizationUrl);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to connect email"); setPending(null); }
  }

  function renderCatalogue() {
    return <div className="connections-catalogue">
      {(addOpen ? Object.entries(providerDetails) : catalogue).map(([provider, detail]) => {
        const Icon = detail.icon;
        return <div key={provider} className="connections-platform-row">
          <span className="connections-provider-mark"><Icon className={`size-7 ${detail.iconClass}`} /></span>
          <div className="min-w-0 flex-1"><p className="text-sm font-medium">{detail.label}</p><p className="mt-0.5 text-xs text-muted-foreground">{providerPurposes[provider]}</p></div>
          <Button variant="outline" size="icon" className="connections-add-button" onClick={() => connectProvider(provider)} aria-label={`Connect ${detail.label}`}><Plus className="size-4" /></Button>
        </div>;
      })}
      {addOpen || category === "all" || category === "email" ? ([{ provider: "google" as const, name: "Gmail", purpose: "Email conversations" }, { provider: "microsoft" as const, name: "Outlook", purpose: "Email conversations" }].filter(item => addOpen || matchesSearch([item.name, item.provider])).map(item => <div className="connections-platform-row" key={item.provider}>
        <span className="connections-provider-mark"><MailBrand provider={item.provider} /></span><div className="min-w-0 flex-1"><p className="text-sm font-medium">{item.name}</p><p className="mt-0.5 text-xs text-muted-foreground">{item.purpose}</p></div>
        <Button variant="outline" size="icon" className="connections-add-button" disabled={pending !== null} onClick={() => void connectEmail(item.provider)} aria-label={`Connect ${item.name}`}><Plus className="size-4" /></Button>
      </div>)) : null}
    </div>;
  }

  async function setStatus(connection: WorkspaceConnection, status: "DISCONNECTED" | "REVOKED") {
    setPending(`${connection.id}:${status}`);
    setError("");

    try {
      const response = await fetch(apiUrl(`/api/connections/${connection.id}/status`), {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Connection update failed");
      setSelectedConnection(null);
      if (status === "DISCONNECTED") {
        setShownConnections((current) => current.filter((item) => item.id !== connection.id));
      }
      toast.success(status === "DISCONNECTED" ? "Account removed" : "Connection marked revoked");
      revalidator.revalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Connection update failed");
    } finally {
      setPending(null);
    }
  }

  async function confirmStatusUpdate(connection: WorkspaceConnection, status: "DISCONNECTED" | "REVOKED") {
    const removing = status === "DISCONNECTED";
    const confirmed = await confirm({
      title: `${removing ? "Remove" : "Mark revoked"} ${connection.displayName}?`,
      description: removing
        ? "This disconnects the account from this workspace."
        : "This marks the connection as revoked and stops it from being used.",
      confirmLabel: removing ? "Remove" : "Mark revoked",
      variant: "destructive",
    });

    if (confirmed) await setStatus(connection, status);
  }

  function beginWhatsappEmbeddedSignup() {
    window.dispatchEvent(new Event("kasitek:start-whatsapp-embedded-signup"));
  }

  function startOAuthConnection(path: string) {
    setPending("oauth:redirect");
    window.location.assign(apiUrl(path));
  }

  function metaConnectionPath(target: "facebook" | "instagram", capabilities: string[], connectionId?: string) {
    const params = new URLSearchParams({ target });
    if (capabilities.length) params.set("capabilities", capabilities.join(","));
    if (connectionId) params.set("connectionId", connectionId);
    return `/api/social/oauth/meta/start?${params.toString()}`;
  }

  function providerAccessOptions(provider: string) {
    const keys = PROVIDER_ACCESS_KEYS[provider];
    const unavailable = PROVIDER_UNAVAILABLE_ACCESS_KEYS[provider] ?? [];
    const options = keys ? ACCESS_OPTIONS.filter((option) => keys.includes(option.key)) : ACCESS_OPTIONS;
    return options.map((option) => unavailable.includes(option.key)
      ? { ...option, available: false, availabilityLabel: "Requires approval" }
      : { ...option, available: true });
  }

  function providerConnectionPath(provider: string, capabilities: string[]) {
    const path = providerDetails[provider as keyof typeof providerDetails]?.connectPath;
    if (!path || path === "#whatsapp-setup") return null;
    const availableCapabilities = capabilities.filter((key) => providerAccessIsAvailable(provider, key));
    if (availableCapabilities.length === 0) return path;
    const params = new URLSearchParams({ capabilities: availableCapabilities.join(",") });
    return `${path}?${params.toString()}`;
  }

  function requestConnectionAccess() {
    if (!selectedConnection || requestedPermissionKeys.length === 0) return;
    const availablePermissions = requestedPermissionKeys.filter((key) => providerAccessIsAvailable(selectedConnection.provider, key));
    if (availablePermissions.length === 0) return;
    const params = new URLSearchParams({ capabilities: availablePermissions.join(",") });
    startOAuthConnection(`/api/connections/${encodeURIComponent(selectedConnection.id)}/access/request?${params.toString()}`);
  }

  async function connectBluesky() {
    setPending("bluesky:connect");
    setError("");

    try {
      const response = await fetch(apiUrl("/api/social/oauth/bluesky/readiness"), {
        credentials: "include",
        cache: "no-store",
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "Bluesky connection is not ready");

      const handle = normalizeBlueskyHandle(blueskyHandle);
      setBlueskyHandle(handle);
      const capabilities = selectedAccess.filter((key) => PROVIDER_ACCESS_KEYS.BLUESKY.includes(key));
      const params = new URLSearchParams({ handle, capabilities: capabilities.join(",") });
      window.location.assign(apiUrl(`/api/social/oauth/bluesky/start?${params.toString()}`));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Bluesky connection is not ready");
      setPending(null);
    }
  }

  return (
    <div className="connections-workspace space-y-7">
      {error ? (
        <div className="flex items-start justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <span>{error}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="-mr-2 -mt-2 shrink-0 text-current hover:bg-destructive/10"
            onClick={() => setError("")}
            aria-label="Dismiss message"
          >
            <CloseIcon />
          </Button>
        </div>
      ) : null}

      <PageHeader>
        <PageHeaderContent><PageHeaderTitle>Connections</PageHeaderTitle></PageHeaderContent>
        <PageHeaderActions><label className="connections-search"><Search className="size-4 text-muted-foreground" /><Input aria-label="Search connections" placeholder="Search connections…" value={search} onChange={event => setSearch(event.target.value)} /></label><Button onClick={() => setAddOpen(true)}><Plus className="size-4" />Add connection</Button></PageHeaderActions>
      </PageHeader>
      <div className="connections-status-tabs" role="group" aria-label="Connection status">
        {([{ id: "all", label: "All", count: counts.all }, { id: "connected", label: "Connected", count: counts.connected }, { id: "attention", label: "Needs attention", count: counts.attention }]).map(tab => <button key={tab.id} type="button" aria-pressed={statusFilter === tab.id} onClick={() => setStatusFilter(tab.id)}>{tab.label}<span>{tab.count}</span></button>)}
      </div>
      <section aria-labelledby="connected-accounts-heading">
        <h2 id="connected-accounts-heading" className="mb-4 text-base font-semibold">Connected accounts</h2>
        {loadFailed ? <div role="alert" className="connections-feedback">Unable to load connected accounts.<Button variant="outline" size="sm" onClick={() => revalidator.revalidate()}>Retry</Button></div> : null}
        {emailLoadFailed ? <div role="alert" className="connections-feedback">Unable to load email accounts.<Button variant="outline" size="sm" onClick={() => revalidator.revalidate()}>Retry</Button></div> : null}
        <div className="connections-table-scroll" role="region" aria-label="Connected accounts" tabIndex={0}>
          <table className="connections-account-table"><thead><tr><th>Account</th><th>Platform</th><th>Access</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
            {filteredConnections.map(connection => {
              const detail = providerDetails[connection.provider as keyof typeof providerDetails];
              const Icon = detail?.icon ?? Radio;
              const status = statusPresentation(connection.status);
              const access = [...new Set(connection.permissions.filter(item => item.state === "GRANTED").map(item => item.group === "MESSAGING" ? "Messages" : item.group === "PUBLISHING" ? "Publishing" : readableStatus(item.group)))];
              return <tr key={connection.id}>
                <td><button type="button" className="connections-account-name" onClick={() => { setRequestedPermissionKeys([]); setSelectedConnection(connection); }}><span className="connections-provider-mark"><Icon className={`size-7 ${detail?.iconClass ?? "text-muted-foreground"}`} /></span><span className="min-w-0"><span className="block truncate font-medium">{connection.displayName}</span>{connection.handle ? <span className="mt-0.5 block truncate text-xs text-muted-foreground">{connection.handle}</span> : null}</span></button></td>
                <td><span className="inline-flex items-center gap-2"><Icon className={`size-4 ${detail?.iconClass ?? ""}`} />{detail?.label ?? connection.provider}</span></td>
                <td className="text-muted-foreground">{access.join(", ") || "Not verified"}</td>
                <td><span className={`connections-status ${status.className}`}><span className="size-1.5 rounded-full bg-current" />{status.label}</span></td>
                <td><div className="flex items-center justify-end gap-2">{connection.status === "NEEDS_ATTENTION" ? <Button variant="outline" size="sm" onClick={() => setSelectedConnection(connection)}>Reconnect</Button> : null}<DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`Actions for ${connection.displayName}`}><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => { setRequestedPermissionKeys([]); setSelectedConnection(connection); }}>Manage account</DropdownMenuItem><DropdownMenuItem disabled={pending !== null} onSelect={() => void confirmStatusUpdate(connection, "DISCONNECTED")} className="text-destructive">Disconnect</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div></td>
              </tr>;
            })}
            {filteredMailboxes.map(connection => {
              const provider = connection.provider === "GOOGLE" ? "google" : "microsoft";
              const status = statusPresentation(emailStatus(connection) as WorkspaceConnection["status"]);
              return <tr key={`email:${connection.id}`}><td><button type="button" className="connections-account-name" onClick={() => setMailbox(connection)}><span className="connections-provider-mark"><MailBrand provider={provider} /></span><span className="min-w-0"><span className="block truncate font-medium">{connection.displayName || connection.emailAddress}</span><span className="mt-0.5 block truncate text-xs text-muted-foreground">{connection.emailAddress}</span></span></button></td><td>{provider === "google" ? "Gmail" : "Outlook"}</td><td className="text-muted-foreground">Email</td><td><span className={`connections-status ${status.className}`}><span className="size-1.5 rounded-full bg-current" />{status.label}</span></td><td className="text-right"><Button variant="ghost" size="icon" aria-label={`Manage ${connection.emailAddress}`} onClick={() => setMailbox(connection)}><MoreHorizontal className="size-4" /></Button></td></tr>;
            })}
          </tbody></table>
          {!filteredConnections.length && !filteredMailboxes.length ? <div className="connections-empty">{query || statusFilter !== "all" ? "No matching accounts" : "No accounts connected"}</div> : null}
        </div>
      </section>
      <section aria-labelledby="platform-catalogue-heading">
        <h2 id="platform-catalogue-heading" className="mb-3 text-base font-semibold">Add a platform</h2>
        <div className="connections-categories" role="group" aria-label="Platform category">{[["all", "All platforms"], ["messaging", "Messaging"], ["publishing", "Publishing"], ["email", "Email"]].map(([id, label]) => <button key={id} type="button" aria-pressed={category === id} onClick={() => setCategory(id)}>{label}</button>)}</div>
        {renderCatalogue()}
      </section>
      <a href="#connection-reporting" className="inline-flex min-h-9 items-center gap-2 text-xs font-medium text-primary"><Clock className="size-4" />Connection reporting<ArrowRight className="size-3.5" /></a>
      <Dialog open={addOpen} onOpenChange={setAddOpen}><DialogContent className="connections-add-dialog"><DialogHeader><DialogTitle>Add connection</DialogTitle><DialogDescription className="sr-only">Choose an account provider</DialogDescription></DialogHeader>{renderCatalogue()}</DialogContent></Dialog>
      <Dialog open={Boolean(mailbox)} onOpenChange={open => !open && setMailbox(null)}><DialogContent><DialogHeader><DialogTitle>{mailbox?.emailAddress}</DialogTitle><DialogDescription>Email account</DialogDescription></DialogHeader>{mailbox ? <><dl className="space-y-3 text-sm">{[["Health", mailbox.healthStatus], ["Sync", mailbox.syncStatus], ["Inbox", mailbox.inboxStatus], ["Inbound", mailbox.inboundStatus], ["Outbound", mailbox.outboundStatus]].map(([label,value]) => <div key={label} className="flex justify-between gap-4"><dt className="text-muted-foreground">{label}</dt><dd>{readableStatus(value)}</dd></div>)}</dl><DialogFooter><Button variant="outline" asChild><Link to="/inbox?channel=email">View inbox</Link></Button><Button disabled={pending !== null} onClick={() => void connectEmail(mailbox.provider === "GOOGLE" ? "google" : "microsoft")}>Reconnect</Button></DialogFooter></> : null}</DialogContent></Dialog>

      <Sheet
        open={permissionConnectProvider !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setPermissionConnectProvider(null);
        }}
      >
        <SheetContent side="right" className="w-full max-w-lg overflow-y-auto border-l border-border p-6 sm:w-[30rem]">
          {permissionConnectProvider ? (
            <div className="space-y-6">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Connect an account</p>
                <h2 className="mt-1 text-xl font-semibold">
                  {providerDetails[permissionConnectProvider as keyof typeof providerDetails]?.label ?? permissionConnectProvider}
                </h2>
              </div>
              <AccessSelection
                value={selectedAccess.filter((key) => providerAccessOptions(permissionConnectProvider).some((option) => option.key === key))}
                onChange={setSelectedAccess}
                options={providerAccessOptions(permissionConnectProvider)}
              />
              <Button
                className="w-full"
                disabled={permissionConnectProvider !== "TIKTOK" && selectedAccess.filter((key) => providerAccessOptions(permissionConnectProvider).some((option) => option.key === key)).length === 0}
                onClick={() => {
                  const capabilities = selectedAccess.filter((key) => providerAccessOptions(permissionConnectProvider).some((option) => option.key === key));
                  const path = providerConnectionPath(permissionConnectProvider, capabilities);
                  setPermissionConnectProvider(null);
                  if (path) startOAuthConnection(path);
                }}
              >
                Continue to provider
              </Button>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>

      <Dialog open={Boolean(instagramConnectPath)} onOpenChange={(open) => !open && setInstagramConnectPath(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Before connecting Instagram</DialogTitle>
            <DialogDescription>
              Make sure you are already signed in to the Instagram account you want to connect in this browser.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setInstagramConnectPath(null)}>Cancel</Button>
            <Button variant="outline" asChild>
              <a href="https://www.instagram.com/" target="_blank" rel="noreferrer">Open Instagram</a>
            </Button>
            <Button onClick={() => {
              const path = instagramConnectPath;
              setInstagramConnectPath(null);
              setConnectionPicker(null);
              if (path) startOAuthConnection(path);
            }}>
              I&apos;m signed in — Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Sheet
        open={connectionPicker !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setConnectionPicker(null);
        }}
      >
        <SheetContent side="right" className="w-full max-w-lg overflow-y-auto border-l border-border p-6 sm:w-[30rem]">
          {connectionPicker ? (
            <div className="space-y-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Connect an account</p>
                  <h2 className="mt-1 text-xl font-semibold">
                    {connectionPicker === "FACEBOOK"
                      ? "Choose Facebook Pages"
                      : "Choose an Instagram connection"}
                  </h2>
                </div>
                <Button variant="ghost" size="icon-sm" onClick={() => setConnectionPicker(null)} aria-label="Close account picker">
                  <CloseIcon />
                </Button>
              </div>

              {connectionPicker === "FACEBOOK" ? (
                <div className="space-y-4">
                  <div className="rounded-lg border bg-secondary/40 p-4">
                    <div className="flex items-start gap-3">
                      <div className="rounded-md border bg-background p-2"><FacebookBrandIcon className={`h-5 w-5 ${getPlatformBrandColor("FACEBOOK")}`} /></div>
                      <div>
                        <h3 className="font-medium">Facebook Pages</h3>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Meta will ask which Pages KasiTek may access. Use the Page selection or Edit access step to choose the specific Pages you want in this workspace.
                        </p>
                      </div>
                    </div>
                  </div>
                  <AccessSelection value={selectedAccess} onChange={setSelectedAccess} />
                  <Button
                    className="w-full"
                    disabled={selectedAccess.length === 0}
                    onClick={() => startOAuthConnection(metaConnectionPath("facebook", selectedAccess))}
                  >
                    Continue to Meta
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Only Facebook Pages returned by this connection flow will be added to the Facebook section.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="space-y-3 rounded-lg border p-4">
                    <div className="flex items-start gap-3">
                      <div className="rounded-md border bg-secondary p-2"><InstagramBrandIcon className={`h-5 w-5 ${getPlatformBrandColor("INSTAGRAM")}`} /></div>
                      <div>
                        <h3 className="font-medium">Instagram Login</h3>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Business or Creator account. No Facebook Page required.
                        </p>
                      </div>
                    </div>
                    <Button
                      className="w-full"
                      onClick={() => setInstagramConnectPath("/api/social/oauth/instagram/start")}
                    >
                      Connect Instagram
                    </Button>
                  </div>

                  <div className="space-y-3 rounded-lg border p-4">
                    <div className="flex items-start gap-3">
                      <div className="rounded-md border bg-secondary p-2"><FacebookBrandIcon className={`h-5 w-5 ${getPlatformBrandColor("FACEBOOK")}`} /></div>
                      <div>
                        <h3 className="font-medium">Instagram through Meta Login</h3>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Choose the access KasiTek should request for the Instagram account linked to a Facebook Page.
                        </p>
                      </div>
                    </div>
                    <AccessSelection value={selectedAccess} onChange={setSelectedAccess} />
                    <Button
                      className="w-full"
                      disabled={selectedAccess.length === 0}
                      onClick={() => startOAuthConnection(metaConnectionPath("instagram", selectedAccess))}
                    >
                      Continue to Meta
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </SheetContent>
      </Sheet>

      <Sheet open={blueskyOpen} onOpenChange={setBlueskyOpen}>
        <SheetContent side="right" className="w-full max-w-lg overflow-y-auto border-l border-border p-6 sm:w-[30rem]">
          <div className="space-y-6">
            <div><p className="text-sm font-medium text-muted-foreground">Connect an account</p><h2 className="mt-1 text-xl font-semibold">Bluesky</h2></div>
            <p className="text-sm text-muted-foreground">Enter the account handle, then authorize KasiTek on the account provider&apos;s consent screen. Your Bluesky password is never shared with KasiTek.</p>
            <label className="block space-y-2"><span className="text-sm font-medium">Handle</span><Input value={blueskyHandle} onChange={(event) => setBlueskyHandle(event.target.value)} placeholder="business or business.bsky.social" autoComplete="username" /><span className="block text-xs text-muted-foreground">We add <code>.bsky.social</code> when you enter only a handle.</span></label>
            <AccessSelection
              value={selectedAccess.filter((key) => PROVIDER_ACCESS_KEYS.BLUESKY.includes(key))}
              onChange={setSelectedAccess}
              options={providerAccessOptions("BLUESKY")}
            />
            <Button className="w-full" disabled={pending !== null || !blueskyHandle.trim()} onClick={connectBluesky}>{pending === "bluesky:connect" ? "Redirecting…" : "Continue to Bluesky"}</Button>
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={selectedConnection !== null} onOpenChange={(open: boolean) => { if (!open) setSelectedConnection(null); }}>
        <SheetContent side="right" className="w-full max-w-xl overflow-y-auto border-l border-border p-5 sm:w-[32rem]">
          {selectedConnection ? (() => {
            const providerDetail = providerDetails[selectedConnection.provider as keyof typeof providerDetails];
            const Icon = providerDetail?.icon ?? Radio;
            const status = statusPresentation(selectedConnection.status);
            const isLinkedInPage = selectedConnection.provider === "LINKEDIN"
              && selectedConnection.metadata?.accountType === "organization";
            const reconnectPath = providerDetail?.connectPath;
            const requestablePermissions = selectedConnection.permissions.filter((permission) => permission.requestable && providerAccessIsAvailable(selectedConnection.provider, permission.key));
            const rows = [
              ["Provider", providerDetail?.label ?? selectedConnection.provider],
              ["Account ID", selectedConnection.externalAccountId ?? "—"],
              ["Handle", selectedConnection.handle ?? "—"],
              ["Credentials", readableStatus(selectedConnection.credentialStatus)],
              ["Health", readableStatus(selectedConnection.healthStatus)],
              ["Webhook", readableStatus(selectedConnection.webhookStatus)],
              ["Last checked", selectedConnection.lastCheckedAt ?? "Not checked yet"],
              ["Connected", selectedConnection.createdAt],
              ["Last updated", selectedConnection.updatedAt],
            ];

            return (
              <div className="space-y-6">
                <div className="flex items-center gap-3 pr-8">
                    <div className="rounded-md border bg-secondary p-2"><Icon className={`h-5 w-5 ${providerDetail?.iconClass ?? "text-muted-foreground"}`} /></div>
                    <div><p className="font-semibold">{selectedConnection.displayName}</p><p className="text-sm text-muted-foreground">{isLinkedInPage ? "LinkedIn Company Page" : "Connection details"}</p></div>
                </div>

                <Badge variant="outline" className={status.className}>{status.label}</Badge>

                <div className="space-y-1 rounded-lg border p-3">
                  {rows.map(([label, value]) => <div key={label} className="grid grid-cols-[8rem_1fr] gap-3 py-2 text-sm"><span className="text-muted-foreground">{label}</span><span className="break-all font-medium">{value}</span></div>)}
                </div>

                <div><h3 className="mb-2 text-sm font-semibold">Workspace use</h3><div className="flex flex-wrap gap-1.5">{selectedConnection.consumers.length ? selectedConnection.consumers.map((item) => <Badge key={item} variant="secondary">{productLabels[item] ?? item}</Badge>) : <span className="text-sm text-muted-foreground">Not assigned to a workspace feature yet.</span>}</div></div>

                <div><h3 className="mb-2 text-sm font-semibold">Capabilities</h3><div className="flex flex-wrap gap-1.5">{selectedConnection.capabilities.length ? selectedConnection.capabilities.map((capability) => <Badge key={capability.key} variant="outline" className={!capability.enabled ? "opacity-50" : ""}>{capability.key.toLowerCase().replaceAll("_", " ")}{capability.entitlementKey ? ` · ${capability.entitlementKey}` : ""}</Badge>) : <span className="text-sm text-muted-foreground">No capabilities reported.</span>}</div></div>

                <div>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold">Access</h3>
                      <p className="text-xs text-muted-foreground">Provider access for this connection.</p>
                    </div>
                    {selectedConnection.permissions.some((permission) => permission.authMode) ? (
                      <Badge variant="outline" className="text-xs">
                        {selectedConnection.permissions.find((permission) => permission.authMode)?.authMode === "instagram_login"
                          ? "Instagram Login"
                          : selectedConnection.permissions.find((permission) => permission.authMode)?.authMode === "whatsapp_embedded_signup"
                            ? "Embedded Signup"
                            : selectedConnection.permissions.find((permission) => permission.authMode)?.authMode?.replaceAll("_", " ") ?? "Provider access"}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="space-y-2 rounded-lg border p-3">
                    {selectedConnection.permissions.length ? selectedConnection.permissions.map((permission) => (
                      <label key={permission.key} className={`flex items-start gap-3 rounded-md p-2 ${permission.requestable && providerAccessIsAvailable(selectedConnection.provider, permission.key) ? "cursor-pointer hover:bg-secondary/50" : ""}`}>
                        {permission.requestable && providerAccessIsAvailable(selectedConnection.provider, permission.key) ? (
                          <input
                            type="checkbox"
                            aria-label={`Request ${permission.label}`}
                            className="mt-0.5 size-4 accent-primary"
                            checked={requestedPermissionKeys.includes(permission.key)}
                            onChange={(event) => setRequestedPermissionKeys((current) => event.target.checked
                              ? [...current, permission.key]
                              : current.filter((key) => key !== permission.key))}
                          />
                        ) : permission.state === "GRANTED" ? (
                          <Check className="mt-0.5 size-4 text-status-success" aria-label="Granted" />
                        ) : (
                          <LockKeyhole className="mt-0.5 size-4 text-muted-foreground" aria-label={accessStateLabels[permission.state] ?? "Unavailable"} />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                            {permission.label}
                            <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${accessStateClass(permission.state)}`}>
                              {accessStateLabels[permission.state] ?? permission.state.replaceAll("_", " ")}
                            </span>
                          </span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">{permission.description}</span>
                          {!providerAccessIsAvailable(selectedConnection.provider, permission.key) ? <span className="mt-0.5 block text-xs text-muted-foreground">Requires provider approval.</span> : permission.state === "UNSUPPORTED" ? <span className="mt-0.5 block text-xs text-muted-foreground">This access is not available through this connection type.</span> : null}
                        </span>
                      </label>
                    )) : <span className="text-sm text-muted-foreground">Access has not been verified yet.</span>}
                  </div>
                  {requestablePermissions.length ? (
                    <Button
                      size="sm"
                      className="mt-3"
                      disabled={pending !== null || requestedPermissionKeys.length === 0}
                      onClick={requestConnectionAccess}
                    >
                      <LockKeyhole />{selectedConnection.provider === "WHATSAPP" ? "Open setup" : "Grant access"}
                    </Button>
                  ) : null}
                </div>

                {selectedConnection.lastError ? <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{selectedConnection.lastError}</div> : null}

                <div className="flex flex-wrap gap-2 border-t pt-4">
                  {selectedConnection.provider === "WHATSAPP" ? (
                    <Button
                      size="sm"
                      disabled={pending !== null}
                      onClick={() => {
                        setSelectedConnection(null);
                        beginWhatsappEmbeddedSignup();
                      }}
                    >
                      <RefreshCw />Reconnect with Meta
                    </Button>
                  ) : selectedConnection.status !== "CONNECTED" && reconnectPath ? (
                    <Button size="sm" onClick={() => startOAuthConnection(reconnectPath)}>
                      <RefreshCw />Reconnect
                    </Button>
                  ) : null}
                  {selectedConnection.status === "CONNECTED" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending !== null}
                      onClick={() => void confirmStatusUpdate(selectedConnection, "DISCONNECTED")}
                    >
                      <Unplug />Remove
                    </Button>
                  ) : null}
                  {selectedConnection.status !== "REVOKED" ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending !== null}
                      onClick={() => void confirmStatusUpdate(selectedConnection, "REVOKED")}
                    >
                      <Bot />Mark revoked
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })() : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
