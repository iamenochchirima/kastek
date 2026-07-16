"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { WorkspaceConnection } from "@/lib/connections";
import { apiUrl } from "@/lib/server-api";
import {
  AtSign,
  Bot,
  CheckCircle2,
  Facebook,
  Instagram,
  Linkedin,
  MessageCircle,
  Radio,
  RefreshCw,
  Send,
  ShieldAlert,
  Unplug,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

const providerDetails = {
  WHATSAPP: { label: "WhatsApp", icon: MessageCircle, connectPath: "#whatsapp-setup" },
  FACEBOOK: { label: "Facebook", icon: Facebook, connectPath: "/api/social/oauth/meta/start" },
  INSTAGRAM: { label: "Instagram", icon: Instagram, connectPath: "/api/social/oauth/meta/start" },
  THREADS: { label: "Threads", icon: AtSign, connectPath: null },
  LINKEDIN: { label: "LinkedIn", icon: Linkedin, connectPath: "/api/social/oauth/linkedin/start" },
  X: { label: "X", icon: Send, connectPath: "/api/social/oauth/x/start" },
} as const;

const capabilityLabels: Record<string, string> = {
  AGENT_CHANNEL: "Agents",
  CAMPAIGNS_SEND: "Campaigns",
  COMMENTS_MANAGE: "Comments",
  MEDIA_PUBLISH: "Media",
  MESSAGING_INBOUND: "Receive messages",
  MESSAGING_OUTBOUND: "Send messages",
  SOCIAL_ANALYTICS: "Analytics",
  SOCIAL_PUBLISH: "Publish",
  TEMPLATES_MANAGE: "Templates",
};

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

export function ConnectionsManager({ connections }: { connections: WorkspaceConnection[] }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");

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

  const connectedCount = connections.filter((item) => item.status === "CONNECTED").length;
  const attentionCount = connections.filter((item) => item.status === "NEEDS_ATTENTION").length;

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="gap-2 py-4">
          <CardContent className="flex items-center justify-between">
            <div><p className="text-2xl font-semibold">{connectedCount}</p><p className="text-sm text-muted-foreground">Connected accounts</p></div>
            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
          </CardContent>
        </Card>
        <Card className="gap-2 py-4">
          <CardContent className="flex items-center justify-between">
            <div><p className="text-2xl font-semibold">{attentionCount}</p><p className="text-sm text-muted-foreground">Need attention</p></div>
            <ShieldAlert className="h-5 w-5 text-amber-500" />
          </CardContent>
        </Card>
        <Card className="gap-2 py-4">
          <CardContent className="flex items-center justify-between">
            <div><p className="text-2xl font-semibold">{connections.length}</p><p className="text-sm text-muted-foreground">Provider accounts</p></div>
            <Radio className="h-5 w-5 text-primary" />
          </CardContent>
        </Card>
      </div>

      {error ? <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div> : null}

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Connected accounts</h2>
          <p className="text-sm text-muted-foreground">Provider accounts shared by workspace features.</p>
        </div>
        {connections.length === 0 ? (
          <Card><CardContent className="py-6 text-sm text-muted-foreground">No provider accounts are connected yet.</CardContent></Card>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {connections.map((connection) => {
              const detail = providerDetails[connection.provider as keyof typeof providerDetails];
              const Icon = detail?.icon ?? Radio;
              const status = statusPresentation(connection.status);
              const reconnectPath = detail?.connectPath;
              return (
                <Card key={connection.id} className="overflow-hidden">
                  <CardHeader className="border-b">
                    <div className="flex min-w-0 items-start gap-3">
                      <div className="rounded-md border bg-secondary p-2"><Icon className="h-5 w-5" /></div>
                      <div className="min-w-0">
                        <CardTitle className="truncate">{connection.displayName}</CardTitle>
                        <p className="mt-1 text-sm text-muted-foreground">{detail?.label ?? connection.provider}{connection.handle ? ` · ${connection.handle}` : ""}</p>
                      </div>
                    </div>
                    <Badge variant="outline" className={status.className}>{status.label}</Badge>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-3 gap-3 text-xs">
                      <div><p className="text-muted-foreground">Credentials</p><p className="mt-1 font-medium">{connection.credentialStatus.toLowerCase().replaceAll("_", " ")}</p></div>
                      <div><p className="text-muted-foreground">Health</p><p className="mt-1 font-medium">{connection.healthStatus.toLowerCase().replaceAll("_", " ")}</p></div>
                      <div><p className="text-muted-foreground">Webhook</p><p className="mt-1 font-medium">{connection.webhookStatus.toLowerCase().replaceAll("_", " ")}</p></div>
                    </div>
                    <div>
                      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Used by</p>
                      <div className="flex flex-wrap gap-2">{connection.consumers.map((item) => <Badge key={item} variant="secondary">{productLabels[item] ?? item}</Badge>)}</div>
                    </div>
                    <div>
                      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Capabilities</p>
                      <div className="flex flex-wrap gap-2">{connection.capabilities.map((capability) => <Badge key={capability.key} variant="outline" className={!capability.enabled ? "opacity-50" : ""}>{capabilityLabels[capability.key] ?? capability.key}{capability.entitlementKey ? " · subscription" : ""}</Badge>)}</div>
                    </div>
                    {connection.lastError ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{connection.lastError}</p> : null}
                    <div className="flex flex-wrap gap-2 border-t pt-4">
                      {connection.status !== "CONNECTED" && reconnectPath ? (
                        <Button asChild size="sm"><a href={reconnectPath.startsWith("#") ? reconnectPath : apiUrl(reconnectPath)}><RefreshCw />Reconnect</a></Button>
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
        )}
      </section>

      <section className="space-y-3">
        <div><h2 className="text-lg font-semibold">Add provider</h2><p className="text-sm text-muted-foreground">Connect another account to this workspace.</p></div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Object.entries(providerDetails).map(([provider, detail]) => {
            const Icon = detail.icon;
            return (
              <Card key={provider} className="py-4">
                <CardContent className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3"><div className="rounded-md border bg-secondary p-2"><Icon className="h-5 w-5" /></div><div><p className="font-medium">{detail.label}</p><p className="text-xs text-muted-foreground">{detail.connectPath ? "Available" : "Not wired yet"}</p></div></div>
                  {detail.connectPath ? <Button asChild variant="outline" size="sm"><a href={detail.connectPath.startsWith("#") ? detail.connectPath : apiUrl(detail.connectPath)}>Connect</a></Button> : <Button variant="outline" size="sm" disabled>Planned</Button>}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>
    </div>
  );
}
