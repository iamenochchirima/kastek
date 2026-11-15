import { apiUrl } from "@/lib/server-api";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type TelegramConnection = {
  id: string;
  name: string;
  assetId: string | null;
  state: string;
  revision: number;
  metadata: Record<string, unknown>;
  updatedAt: string;
};

type Health = {
  status: string;
  steps?: Array<{ step: string; ok: boolean; detail: string }>;
};

const stateLabel: Record<string, string> = {
  active: "Connected",
  pending: "Pending",
  needs_attention: "Needs attention",
  disconnected: "Disconnected",
};

export default function TelegramConnectionCard() {
  const [connections, setConnections] = useState<TelegramConnection[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [name, setName] = useState("");
  const [botToken, setBotToken] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [healthLoadingId, setHealthLoadingId] = useState<string | null>(null);
  const [healthById, setHealthById] = useState<Record<string, Health>>({});
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [rotateId, setRotateId] = useState<string | null>(null);
  const [rotateToken, setRotateToken] = useState("");

  async function load() {
    try {
      const response = await fetch(apiUrl("/api/telegram/connections"), {
        credentials: "include",
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Failed to load Telegram connections");
      setConnections(body.connections || []);
      setCanManage(Boolean(body.canManage));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load Telegram connections");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function connect() {
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(apiUrl("/api/telegram/connections"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), botToken: botToken.trim() }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Failed to connect Telegram");
      setBotToken("");
      setName("");
      setShowForm(false);
      setNotice("Telegram connected.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to connect Telegram");
    } finally {
      setLoading(false);
    }
  }

  async function health(connection: TelegramConnection) {
    setHealthLoadingId(connection.id);
    setError("");
    try {
      const response = await fetch(
        apiUrl(`/api/telegram/connections/${connection.id}/health`),
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedRevision: connection.revision }),
        },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Health check failed");
      setHealthById((current) => ({ ...current, [connection.id]: body }));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Health check failed");
    } finally {
      setHealthLoadingId(null);
    }
  }

  async function rotate(connection: TelegramConnection) {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        apiUrl(`/api/telegram/connections/${connection.id}/rotate`),
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedRevision: connection.revision,
            botToken: rotateToken.trim(),
          }),
        },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Token update failed");
      setRotateId(null);
      setRotateToken("");
      setNotice("Telegram token updated.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Token update failed");
    } finally {
      setLoading(false);
    }
  }

  async function disconnect(connection: TelegramConnection) {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        apiUrl(`/api/telegram/connections/${connection.id}/disconnect`),
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedRevision: connection.revision }),
        },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Disconnect failed");
      setConfirmingId(null);
      setNotice("Telegram disconnected.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Disconnect failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section id="telegram-setup" className="rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Telegram</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect a Telegram bot to Growth.
          </p>
        </div>
        {canManage ? (
          <Button variant="outline" size="sm" onClick={() => setShowForm((value) => !value)}>
            {showForm ? "Cancel" : "Connect Telegram"}
          </Button>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="mt-4 rounded-lg border border-status-success/30 bg-status-success-soft px-3 py-2 text-sm text-status-success">
          {notice}
        </p>
      ) : null}

      {showForm ? (
        <div className="mt-4 grid gap-4 rounded-lg border border-border p-4 md:grid-cols-2">
          <label className="space-y-2 text-sm">
            <span className="text-muted-foreground">Bot name</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Growth assistant bot" />
          </label>
          <label className="space-y-2 text-sm">
            <span className="text-muted-foreground">Bot token</span>
            <Input
              type="password"
              value={botToken}
              onChange={(event) => setBotToken(event.target.value)}
              placeholder="123456:ABC..."
              autoComplete="off"
            />
          </label>
          <div className="md:col-span-2 flex justify-end">
            <Button onClick={() => void connect()} disabled={loading || !name.trim() || !botToken.trim()}>
              {loading ? "Connecting..." : "Connect Telegram"}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-4 space-y-3">
        {connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">No Telegram bots connected.</p>
        ) : (
          connections.map((connection) => {
            const username =
              typeof connection.metadata.botUsername === "string"
                ? connection.metadata.botUsername
                : null;
            const healthState = healthById[connection.id];
            return (
              <div key={connection.id} className="rounded-lg border border-border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-foreground">{connection.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {username ? `@${username} · ` : ""}
                      {stateLabel[connection.state] ?? connection.state}
                    </p>
                  </div>
                  {canManage ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={healthLoadingId === connection.id}
                        onClick={() => void health(connection)}
                      >
                        {healthLoadingId === connection.id ? "Checking..." : "Check health"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setRotateId((value) => (value === connection.id ? null : connection.id));
                          setRotateToken("");
                        }}
                      >
                        Update token
                      </Button>
                      {confirmingId === connection.id ? (
                        <>
                          <Button variant="destructive" size="sm" disabled={loading} onClick={() => void disconnect(connection)}>
                            Confirm disconnect
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setConfirmingId(null)}>
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button variant="outline" size="sm" onClick={() => setConfirmingId(connection.id)}>
                          Disconnect
                        </Button>
                      )}
                    </div>
                  ) : null}
                </div>
                {rotateId === connection.id ? (
                  <div className="mt-3 flex flex-col gap-2 rounded-lg border border-border bg-secondary/20 p-3 sm:flex-row sm:items-end">
                    <label className="flex-1 space-y-2 text-sm">
                      <span className="text-muted-foreground">New bot token</span>
                      <Input
                        type="password"
                        value={rotateToken}
                        onChange={(event) => setRotateToken(event.target.value)}
                        autoComplete="off"
                      />
                    </label>
                    <Button size="sm" disabled={loading || !rotateToken.trim()} onClick={() => void rotate(connection)}>
                      {loading ? "Saving..." : "Save token"}
                    </Button>
                  </div>
                ) : null}
                {healthState ? (
                  <div className="mt-3 space-y-1 rounded-lg border border-border bg-secondary/20 p-3 text-xs text-muted-foreground">
                    <p>
                      Overall:{" "}
                      <span className={healthState.status === "active" ? "text-status-success" : "text-destructive"}>
                        {healthState.status === "active" ? "Healthy" : "Needs attention"}
                      </span>
                    </p>
                    {healthState.steps?.map((step) => (
                      <p key={step.step}>
                        {step.step}: {step.ok ? "ok" : "failed"} · {step.detail}
                      </p>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
