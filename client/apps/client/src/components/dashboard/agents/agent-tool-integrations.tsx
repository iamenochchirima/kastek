"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, CalendarDays, Check, Link2, LoaderCircle, Search, Unplug } from "lucide-react";
import { SiDiscord, SiInstagram, SiMessenger, SiTelegram, SiWhatsapp } from "react-icons/si";
import type { IconType } from "react-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  disconnectAgentIntegration,
  listAgentInstallationIntegrations,
  saveAgentIntegrationApiKey,
  saveAgentIntegrationLocalConnector,
  startAgentGoogleCalendarOAuth,
  type AgentCapabilityDirectoryEntry,
  type AgentIntegration,
} from "@/lib/agent-platform";

function IntegrationLogo({ integration }: { integration: AgentIntegration }) {
  const channelIcons: Record<string, IconType> = {
    discord: SiDiscord,
    facebook: SiMessenger,
    instagram: SiInstagram,
    telegram: SiTelegram,
    whatsapp: SiWhatsapp,
  };
  const ChannelIcon = integration.channelType ? channelIcons[integration.channelType] : undefined;
  if (ChannelIcon) {
    const channelColor = integration.channelType === "whatsapp"
      ? "text-[#25D366]"
      : integration.channelType === "telegram"
        ? "text-[#229ED9]"
        : integration.channelType === "discord"
          ? "text-[#5865F2]"
          : integration.channelType === "facebook"
            ? "text-[#0084FF]"
            : "text-[#E4405F]";
    return <span className="grid h-9 w-9 place-items-center rounded-lg bg-secondary"><ChannelIcon className={`h-4 w-4 ${channelColor}`} /></span>;
  }
  const fallback = integration.id === "internal.calendar" ? <CalendarDays className="h-5 w-5" /> : integration.id === "tavily.search" ? <Search className="h-5 w-5" /> : integration.id === "opentelemetry" ? <Activity className="h-5 w-5" /> : <Link2 className="h-5 w-5" />;
  if (integration.logo === "google-calendar" || integration.logo === "apple" || integration.logo === "tavily") {
    return <Image src={`/images/integrations/${integration.logo}.svg`} alt="" width={36} height={36} className="h-9 w-9 rounded-lg" />;
  }
  return <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary/10 text-primary">{fallback}</span>;
}

function statusLabel(integration: AgentIntegration): string {
  if (integration.status === "connected" && integration.available) return "Connected";
  if (integration.status === "unhealthy") return "Needs attention";
  if (integration.status === "requires_connector") return "Connector required";
  return "Not configured";
}

function isConnected(integration: AgentIntegration): boolean {
  return integration.status === "connected" && integration.available;
}

export function AgentToolIntegrations({ installationId, embedded = false, refreshKey, onChannelAction, directory, channelsOnly = false }: { installationId: string; embedded?: boolean; refreshKey?: string; onChannelAction?: (integration: AgentIntegration) => void; directory?: AgentCapabilityDirectoryEntry[]; channelsOnly?: boolean }) {
  const [integrations, setIntegrations] = useState<AgentIntegration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AgentIntegration | null>(null);
  const [disconnecting, setDisconnecting] = useState<AgentIntegration | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyIntegration, setBusyIntegration] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listAgentInstallationIntegrations(installationId);
      setIntegrations(response.integrations);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load integrations");
    } finally {
      setLoading(false);
    }
  }, [installationId]);

  useEffect(() => { void refresh(); }, [refresh, refreshKey]);

  const visibleIntegrations = useMemo(() => {
    const available = channelsOnly
      ? integrations.filter((integration) => integration.kind === "channel")
      : onChannelAction ? integrations : integrations.filter((integration) => integration.kind !== "channel");
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = normalizedQuery ? available.filter((integration) => `${integration.name} ${integration.description} ${integration.category}`.toLowerCase().includes(normalizedQuery)) : available;
    const gatewayOrder = new Map([
      ["whatsapp.messaging", 0],
      ["instagram.messaging", 1],
      ["facebook.messaging", 2],
      ["telegram.messaging", 3],
      ["discord.messaging", 4],
    ]);
    const ordered = channelsOnly
      ? [...filtered].sort((left, right) => (gatewayOrder.get(left.id) ?? 99) - (gatewayOrder.get(right.id) ?? 99))
      : filtered;
    if (channelsOnly || !directory?.length) return ordered;
    const integrationsById = new Map(available.map((integration) => [integration.id, integration]));
    return directory
      .filter((entry) => entry.kind === "connector")
      .filter((entry) => !normalizedQuery || `${entry.name} ${entry.description} ${entry.category}`.toLowerCase().includes(normalizedQuery))
      .map((entry): AgentIntegration => integrationsById.get(entry.source.id) ?? {
        id: entry.source.id,
        kind: "tool",
        runtime: "tool_registry",
        name: entry.name,
        description: entry.description,
        category: entry.category,
        auth: entry.runtime.credentialRequirements[0] ?? "internal",
        logo: entry.logo ?? "",
        capabilityNames: [],
        requiredScopes: entry.runtime.requiredScopes,
        configurable: entry.runtime.credentialRequirements.length > 0,
        status: entry.runtime.credentialRequirements.length > 0 ? "not_configured" : "connected",
        available: entry.runtime.credentialRequirements.length === 0,
        hasCredential: entry.runtime.credentialRequirements.length === 0,
        configuration: {},
        connectionId: null,
        connectionCount: 0,
        healthMessage: null,
        lastCheckedAt: null,
      });
  }, [channelsOnly, directory, integrations, onChannelAction, query]);
  const openConfiguration = (integration: AgentIntegration) => {
    setSelected(integration);
    setApiKey("");
    setEndpoint(typeof integration.configuration.endpoint === "string" ? integration.configuration.endpoint : "");
    setSecret("");
  };

  const connectGoogle = async () => {
    setBusyIntegration("google.calendar");
    setError(null);
    try {
      const response = await startAgentGoogleCalendarOAuth(installationId);
      window.location.assign(response.authorizationUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start Google Calendar connection");
      setBusyIntegration(null);
    }
  };

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      if (selected.auth === "api_key") {
        await saveAgentIntegrationApiKey(installationId, selected.id, { apiKey });
      } else {
        await saveAgentIntegrationLocalConnector(installationId, selected.id, { endpoint, secret });
      }
      setSelected(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save integration");
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    if (!disconnecting) return;
    setBusyIntegration(disconnecting.id);
    setError(null);
    try {
      await disconnectAgentIntegration(installationId, disconnecting.id);
      setDisconnecting(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to disconnect integration");
    } finally {
      setBusyIntegration(null);
    }
  };

  const content = <>
    <div className="relative max-w-sm"><Search className="pointer-events-none absolute left-3 top-1/2 z-10 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={channelsOnly ? "Search gateways" : "Search connectors"} className="h-9 pl-9 text-xs" /></div>
    {error ? <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
    {loading ? <div className="grid gap-2 sm:grid-cols-2"><div className="h-24 animate-pulse rounded-xl border border-border bg-secondary/30" /><div className="h-24 animate-pulse rounded-xl border border-border bg-secondary/30" /></div> : null}
    {!loading && visibleIntegrations.length ? <div className={`grid gap-2 ${channelsOnly ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
        {visibleIntegrations.map((integration) => {
          const connected = isConnected(integration);
          const pending = busyIntegration === integration.id;
          const canConfigure = integration.kind !== "channel" && integration.configurable && integration.auth !== "observability";
          return <Card key={integration.id} className="gap-0 border-border bg-card transition-colors hover:border-primary/30">
            <CardContent className={`flex min-h-[84px] items-center gap-3 p-2.5 ${channelsOnly ? "md:min-h-[104px] md:flex-col md:items-start" : ""}`}>
              <div className="flex min-w-0 flex-1 items-center gap-3"><IntegrationLogo integration={integration} /><div className="min-w-0 flex-1"><h4 className="truncate text-sm font-semibold leading-5 text-foreground">{integration.name}</h4><p className="mt-0.5 line-clamp-2 text-xs leading-4 text-muted-foreground">{integration.description}</p></div></div><div className={`flex shrink-0 items-center gap-2 ${channelsOnly ? "w-full justify-between" : "flex-col items-end"}`}><span className="inline-flex items-center gap-1.5 text-[11px] leading-4 text-muted-foreground"><span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-status-success" : "bg-muted-foreground/50"}`} />{statusLabel(integration)}</span>
                {integration.kind === "channel" ? <Button type="button" size="sm" onClick={() => onChannelAction?.(integration)} disabled={pending || !onChannelAction}>{pending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}{connected ? "Manage" : "Connect"}</Button> : null}
                {integration.kind !== "channel" && connected && integration.auth !== "internal" ? <Button type="button" size="sm" variant="ghost" onClick={() => setDisconnecting(integration)} disabled={pending}><Unplug className="h-3.5 w-3.5" />Disconnect</Button> : null}
                {integration.id === "google.calendar" && !connected ? <Button type="button" size="sm" onClick={() => void connectGoogle()} disabled={pending}>{pending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}Connect</Button> : null}
                {canConfigure && integration.id !== "google.calendar" && !connected ? <Button type="button" size="sm" onClick={() => openConfiguration(integration)}>Configure</Button> : null}
                {connected && integration.auth === "local_connector" ? <Button type="button" size="sm" variant="outline" onClick={() => openConfiguration(integration)}>Update</Button> : null}
                {integration.auth === "internal" ? <Badge className="border-status-success/30 bg-status-success-soft text-status-success"><Check className="mr-1 h-3 w-3" />Ready</Badge> : null}
                {integration.auth === "observability" ? <Badge variant="outline">Server</Badge> : null}
              </div>
            </CardContent>
          </Card>;
        })}
      </div> : null}
    {!loading && !visibleIntegrations.length ? <p className="rounded-xl border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">No connectors match this search.</p> : null}

    <Dialog open={Boolean(selected)} onOpenChange={(open) => { if (!open && !saving) setSelected(null); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{selected?.name}</DialogTitle><DialogDescription>{selected?.auth === "api_key" ? "API key" : "Local connector"}</DialogDescription></DialogHeader>
        {selected?.auth === "api_key" ? <label className="text-sm font-medium text-foreground">API key<Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} className="mt-2" autoComplete="off" /></label> : null}
        {selected?.auth === "local_connector" ? <div className="space-y-3"><label className="text-sm font-medium text-foreground">Connector URL<Input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} className="mt-2" placeholder="https://your-mac-connector.example" /></label><label className="text-sm font-medium text-foreground">Connector secret<Input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} className="mt-2" autoComplete="off" /></label></div> : null}
        <DialogFooter><Button type="button" variant="outline" onClick={() => setSelected(null)} disabled={saving}>Cancel</Button><Button type="button" onClick={() => void save()} disabled={saving || (selected?.auth === "api_key" ? !apiKey.trim() : !endpoint.trim() || !secret.trim())}>{saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}Save</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={Boolean(disconnecting)} onOpenChange={(open) => { if (!open && !busyIntegration) setDisconnecting(null); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Disconnect {disconnecting?.name}?</DialogTitle><DialogDescription>Its credentials will no longer be available to this agent.</DialogDescription></DialogHeader>
        <DialogFooter><Button type="button" variant="outline" onClick={() => setDisconnecting(null)} disabled={Boolean(busyIntegration)}>Cancel</Button><Button type="button" variant="destructive" onClick={() => void disconnect()} disabled={Boolean(busyIntegration)}>{busyIntegration ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}Disconnect</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;

  if (embedded) {
    return <div className="space-y-4 border-t border-border pt-5">{content}</div>;
  }

  return <section className="space-y-5" aria-labelledby="agent-integrations-title">
    <div>
      <h2 id="agent-integrations-title" className="text-lg font-semibold text-foreground">Integrations</h2>
      <p className="mt-1 text-sm text-muted-foreground">Connect services and local tools for this agent.</p>
    </div>
    {content}
  </section>;
}
