"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import type { WorkspaceConnection } from "@/lib/connections";
import { apiUrl } from "@/lib/server-api";
import {
  AtSign,
  Bot,
  Facebook,
  Instagram,
  Linkedin,
  MessageCircle,
  Radio,
  RefreshCw,
  Send,
  Unplug,
  X as CloseIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

const providerDetails = {
  WHATSAPP: {
    label: "WhatsApp",
    availableLabel: "Available to connect",
    icon: MessageCircle,
    connectPath: "#whatsapp-setup",
    connectLabel: "Connect",
  },
  FACEBOOK: {
    label: "Facebook",
    availableLabel: "Pages via Meta",
    icon: Facebook,
    connectPath: "/api/social/oauth/meta/start",
    connectLabel: "Connect Meta",
  },
  INSTAGRAM: {
    label: "Instagram",
    availableLabel: "Professional accounts via Meta",
    icon: Instagram,
    connectPath: "/api/social/oauth/meta/start",
    connectLabel: "Connect Instagram",
  },
  THREADS: {
    label: "Threads",
    availableLabel: "Separate Meta integration",
    icon: AtSign,
    connectPath: null,
    connectLabel: "Connect",
  },
  LINKEDIN: {
    label: "LinkedIn",
    availableLabel: "Available to connect",
    icon: Linkedin,
    connectPath: "/api/social/oauth/linkedin/start",
    connectLabel: "Connect",
  },
  X: {
    label: "X",
    availableLabel: "Available to connect",
    icon: Send,
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

function statusPresentation(status: WorkspaceConnection["status"]) {
  switch (status) {
    case "CONNECTED":
      return { label: "Connected", className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-500" };
    case "NEEDS_ATTENTION":
      return { label: "Needs attention", className: "border-amber-500/30 bg-amber-500/10 text-amber-500" };
    case "CONNECTING":
      return { label: "Connecting", className: "border-sky-500/30 bg-sky-500/10 text-sky-500" };
    case "REVOKED":
      return { label: "Revoked", className: "border-destructive/30 bg-destructive/10 text-destructive" };
    default:
      return { label: "Disconnected", className: "border-border bg-secondary text-muted-foreground" };
  }
}

function readableStatus(value: string) {
  return value.toLowerCase().replaceAll("_", " ");
}

function safeProviderDetails(metadata: Record<string, unknown> | null) {
  if (!metadata) return [];

  return Object.entries(metadata).filter(([key]) => !/(token|secret|password|credential)/i.test(key));
}

function formatDetail(value: unknown) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function ConnectionsManager({ connections }: { connections: WorkspaceConnection[] }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [selectedConnection, setSelectedConnection] = useState<WorkspaceConnection | null>(null);
  const groupedConnections = Object.entries(providerDetails)
    .map(([provider, detail]) => ({
      provider,
      detail,
      connections: connections.filter((connection) => connection.provider === provider),
    }))
    .filter((group) => group.connections.length > 0);

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
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Connection update failed");
    } finally {
      setPending(null);
    }
  }

  function beginWhatsappEmbeddedSignup() {
    window.dispatchEvent(new Event("kasitek:start-whatsapp-embedded-signup"));
  }

  return (
    <div className="space-y-8">
      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Connect accounts</h2>
          <p className="text-sm text-muted-foreground">
            Add the channels your workspace will use. You can connect more accounts at any time.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Object.entries(providerDetails).map(([provider, detail]) => {
            const Icon = detail.icon;
            const providerConnections = connections.filter((item) => item.provider === provider);
            const connected = providerConnections.filter((item) => item.status === "CONNECTED").length;
            const canConnect = Boolean(detail.connectPath);
            const actionLabel = connected > 0
              ? provider === "FACEBOOK" || provider === "INSTAGRAM"
                ? "Add Meta accounts"
                : "Add another"
              : detail.connectLabel ?? "Connect";

            return (
              <Card key={provider} className="gap-0 py-0">
                <CardContent className="flex items-center justify-between gap-4 p-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="rounded-md border bg-secondary p-2"><Icon className="h-5 w-5" /></div>
                    <div className="min-w-0">
                      <p className="font-medium">{detail.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {connected > 0 ? (
                          <span className="inline-flex items-center gap-1.5">
                            <span className="inline-flex size-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                              {connected}
                            </span>
                            connected
                          </span>
                        ) : canConnect ? detail.availableLabel ?? "Available to connect" : detail.availableLabel ?? "Coming soon"}
                      </p>
                    </div>
                  </div>

                  {provider === "WHATSAPP" ? (
                    <Button variant={connected > 0 ? "outline" : "default"} size="sm" onClick={beginWhatsappEmbeddedSignup}>
                      {actionLabel}
                    </Button>
                  ) : canConnect ? (
                    <Button asChild variant={connected > 0 ? "outline" : "default"} size="sm">
                      <a href={detail.connectPath!}>{actionLabel}</a>
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" disabled>Planned</Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Connected accounts</h2>
          <p className="text-sm text-muted-foreground">Manage the accounts already available to your workspace.</p>
        </div>

        {connections.length === 0 ? (
          <Card><CardContent className="py-6 text-sm text-muted-foreground">No accounts connected yet.</CardContent></Card>
        ) : (
          <div className="space-y-7">
            {groupedConnections.map((group) => {
              const GroupIcon = group.detail.icon;

              return (
                <section key={group.provider} className="space-y-3">
                  <div className="flex items-center gap-2">
                    <div className="rounded-md border bg-secondary p-1.5"><GroupIcon className="h-4 w-4" /></div>
                    <h3 className="font-medium">{group.detail.label}</h3>
                    <span className="inline-flex size-5 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-muted-foreground">
                      {group.connections.length}
                    </span>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {group.connections.map((connection) => {
                      const detail = group.detail;
              const Icon = detail?.icon ?? Radio;
              const status = statusPresentation(connection.status);
              const reconnectPath = detail?.connectPath;

              return (
                <Card
                  key={connection.id}
                  className="cursor-pointer gap-0 py-0 transition-colors hover:border-primary/50"
                  onClick={() => setSelectedConnection(connection)}
                >
                  <CardContent className="space-y-4 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="rounded-md border bg-secondary p-2"><Icon className="h-5 w-5" /></div>
                        <div className="min-w-0">
                          <p className="truncate font-medium">{connection.displayName}</p>
                          <p className="text-xs text-muted-foreground">
                            {detail?.label ?? connection.provider}{connection.handle ? ` · ${connection.handle}` : ""}
                          </p>
                        </div>
                      </div>
                      <Badge variant="outline" className={status.className}>{status.label}</Badge>
                    </div>

                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>Credentials: <strong className="font-medium text-foreground">{readableStatus(connection.credentialStatus)}</strong></span>
                      <span>Health: <strong className="font-medium text-foreground">{readableStatus(connection.healthStatus)}</strong></span>
                    </div>

                    {connection.consumers.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {connection.consumers.map((item) => <Badge key={item} variant="secondary">{productLabels[item] ?? item}</Badge>)}
                      </div>
                    ) : null}

                    {connection.lastError ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{connection.lastError}</p> : null}

                    <div className="flex flex-wrap gap-2 border-t pt-3" onClick={(event) => event.stopPropagation()}>
                      {connection.status !== "CONNECTED" && reconnectPath ? (
                        <Button asChild size="sm"><a href={reconnectPath}><RefreshCw />Reconnect</a></Button>
                      ) : null}
                      {connection.status === "CONNECTED" ? (
                        <Button variant="outline" size="sm" disabled={pending !== null} onClick={() => void setStatus(connection, "DISCONNECTED")}><Unplug />Disconnect</Button>
                      ) : null}
                      {connection.status !== "REVOKED" ? (
                        <Button variant="ghost" size="sm" disabled={pending !== null} onClick={() => void setStatus(connection, "REVOKED")}><Bot />Mark revoked</Button>
                      ) : null}
                    </div>
                  </CardContent>
                </Card>
              );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </section>

      <Sheet open={selectedConnection !== null} onOpenChange={(open: boolean) => { if (!open) setSelectedConnection(null); }}>
        <SheetContent side="right" className="w-full max-w-xl overflow-y-auto border-l border-border p-5 sm:w-[32rem]">
          {selectedConnection ? (() => {
            const providerDetail = providerDetails[selectedConnection.provider as keyof typeof providerDetails];
            const Icon = providerDetail?.icon ?? Radio;
            const status = statusPresentation(selectedConnection.status);
            const metadataDetails = safeProviderDetails(selectedConnection.metadata);
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
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="rounded-md border bg-secondary p-2"><Icon className="h-5 w-5" /></div>
                    <div><p className="font-semibold">{selectedConnection.displayName}</p><p className="text-sm text-muted-foreground">Connection details</p></div>
                  </div>
                  <Button variant="ghost" size="icon-sm" onClick={() => setSelectedConnection(null)} aria-label="Close details"><CloseIcon /></Button>
                </div>

                <Badge variant="outline" className={status.className}>{status.label}</Badge>

                <div className="space-y-1 rounded-lg border p-3">
                  {rows.map(([label, value]) => <div key={label} className="grid grid-cols-[8rem_1fr] gap-3 py-2 text-sm"><span className="text-muted-foreground">{label}</span><span className="break-all font-medium">{value}</span></div>)}
                </div>

                <div><h3 className="mb-2 text-sm font-semibold">Workspace use</h3><div className="flex flex-wrap gap-1.5">{selectedConnection.consumers.length ? selectedConnection.consumers.map((item) => <Badge key={item} variant="secondary">{productLabels[item] ?? item}</Badge>) : <span className="text-sm text-muted-foreground">Not assigned to a workspace feature yet.</span>}</div></div>

                <div><h3 className="mb-2 text-sm font-semibold">Capabilities</h3><div className="flex flex-wrap gap-1.5">{selectedConnection.capabilities.length ? selectedConnection.capabilities.map((capability) => <Badge key={capability.key} variant="outline" className={!capability.enabled ? "opacity-50" : ""}>{capability.key.toLowerCase().replaceAll("_", " ")}{capability.entitlementKey ? ` · ${capability.entitlementKey}` : ""}</Badge>) : <span className="text-sm text-muted-foreground">No capabilities reported.</span>}</div></div>

                <div><h3 className="mb-2 text-sm font-semibold">Provider data</h3>{metadataDetails.length ? <div className="space-y-1 rounded-lg border p-3">{metadataDetails.map(([key, value]) => <div key={key} className="grid grid-cols-[8rem_1fr] gap-3 py-2 text-sm"><span className="break-all text-muted-foreground">{key}</span><span className="break-all font-medium">{formatDetail(value)}</span></div>)}</div> : <p className="text-sm text-muted-foreground">No additional provider data is stored.</p>}</div>

                {selectedConnection.lastError ? <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{selectedConnection.lastError}</div> : null}
              </div>
            );
          })() : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
