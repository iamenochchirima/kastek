import { apiUrl } from "@/lib/server-api";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Channel = {
  provider: "whatsapp" | "telegram";
  connectionId: string;
  name: string;
  identity: string | null;
  state: string;
  expectedRevision: number | null;
  linked: boolean;
  available: boolean;
};

const providerLabel: Record<Channel["provider"], string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
};

export default function AssistantChannelsCard() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [targetAgentId, setTargetAgentId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingLink, setPendingLink] = useState<Channel | null>(null);

  async function load() {
    try {
      const response = await fetch(apiUrl("/api/assistant/channels"), {
        credentials: "include",
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Failed to load assistant channels");
      setChannels(body.channels || []);
      setTargetAgentId(body.targetAgentId ?? null);
      setCanManage(Boolean(body.canManage));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load assistant channels");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function link(channel: Channel) {
    setPendingLink(null);
    setBusyId(channel.connectionId);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        apiUrl(`/api/assistant/channels/${channel.connectionId}/link`),
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: channel.provider,
            expectedRevision: channel.expectedRevision ?? undefined,
          }),
        },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Failed to link channel");
      setNotice(`${providerLabel[channel.provider]} linked to the Growth assistant.`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to link channel");
    } finally {
      setBusyId(null);
    }
  }

  async function unlink(channel: Channel) {
    setBusyId(channel.connectionId);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        apiUrl(`/api/assistant/channels/${channel.connectionId}/link`),
        {
          method: "DELETE",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: channel.provider }),
        },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Failed to unlink channel");
      setNotice(`${providerLabel[channel.provider]} unlinked from the Growth assistant.`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to unlink channel");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      {error ? (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-lg border border-status-success/30 bg-status-success-soft px-3 py-2 text-sm text-status-success">
          {notice}
        </p>
      ) : null}

      <div className="space-y-3">
        {channels.length === 0 ? (
          <p className="text-sm text-muted-foreground">No channels available.</p>
        ) : (
          channels.map((channel) => (
            <div
              key={`${channel.provider}:${channel.connectionId}`}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4"
            >
              <div className="min-w-0">
                <p className="font-medium text-foreground">
                  {channel.name}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {providerLabel[channel.provider]}
                  </span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {channel.identity ? `${channel.identity} · ` : ""}
                  {channel.linked
                    ? "Linked"
                    : channel.available
                      ? "Not linked"
                      : channel.state.replaceAll("_", " ")}
                </p>
              </div>
              {canManage ? (
                <Button
                  size="sm"
                  variant={channel.linked ? "outline" : "default"}
                  disabled={busyId === channel.connectionId || (!channel.linked && !channel.available)}
                  onClick={() => (channel.linked ? void unlink(channel) : setPendingLink(channel))}
                >
                  {busyId === channel.connectionId
                    ? "Working..."
                    : channel.linked
                      ? "Unlink"
                      : "Link to Growth assistant"}
                </Button>
              ) : null}
            </div>
          ))
        )}
      </div>

      {!targetAgentId ? (
        <p className="text-xs text-muted-foreground">
          The Growth assistant is not provisioned for this workspace.
        </p>
      ) : null}

      <Dialog open={pendingLink !== null} onOpenChange={(open) => { if (!open) setPendingLink(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Route messages to the Growth assistant?</DialogTitle>
            <DialogDescription>
              Inbound {pendingLink ? providerLabel[pendingLink.provider] : ""} messages stop
              appearing in the Growth Inbox. The Growth assistant will receive and answer them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingLink(null)}>
              Cancel
            </Button>
            <Button onClick={() => pendingLink && void link(pendingLink)}>
              Link channel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
