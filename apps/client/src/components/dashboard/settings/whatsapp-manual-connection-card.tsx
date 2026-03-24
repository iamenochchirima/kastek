"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";

type WhatsappConnectionView = {
  id: string;
  phoneNumberId: string;
  phoneDisplayNumber: string | null;
  wabaId: string;
  currentQualityRating: string;
  dailyLimitEstimate: number | null;
  verified: boolean;
  createdAt: string;
};

type ConnectionHealth = {
  healthy: boolean;
  tokenValid: boolean;
  webhookSubscribed: boolean;
  steps: Array<{ step: string; ok: boolean; detail: string }>;
};

export default function WhatsappManualConnectionCard({
  connections,
  mode = "setup",
}: {
  connections: WhatsappConnectionView[];
  mode?: "setup" | "maintenance";
}) {
  const router = useRouter();
  const [showSetupForm, setShowSetupForm] = useState(mode === "setup");
  const [wabaId, setWabaId] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [phoneDisplayNumber, setPhoneDisplayNumber] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editingTokenConnectionId, setEditingTokenConnectionId] = useState<string | null>(null);
  const [updatedAccessToken, setUpdatedAccessToken] = useState("");
  const [tokenUpdateLoadingId, setTokenUpdateLoadingId] = useState<string | null>(null);
  const [healthLoadingId, setHealthLoadingId] = useState<string | null>(null);
  const [actionLoadingKey, setActionLoadingKey] = useState<string | null>(null);
  const [healthByConnectionId, setHealthByConnectionId] = useState<
    Record<string, ConnectionHealth>
  >({});

  async function connectManually() {
    setLoading(true);
    setError("");
    setNotice("");

    try {
      const res = await fetch("/api/whatsapp/connections", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          wabaId,
          phoneNumberId,
          phoneDisplayNumber: phoneDisplayNumber || undefined,
          accessToken,
        }),
      });

      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || "Failed to connect WhatsApp");
      }

      const diagnostics = JSON.stringify(body.diagnostics || []);
      const message = body.webhookSubscribed
        ? "WhatsApp Business connected successfully."
        : body.webhookError || "Connection saved, but webhook subscription needs attention.";

      const params = new URLSearchParams({
        status: "success",
        message,
        diagnostics,
        connectionId: body.connection?.id || "",
        number: body.connection?.phoneDisplayNumber || body.connection?.phoneNumberId || "",
        templates: String(body.templateSync?.synced || 0),
      });

      setShowSetupForm(false);
      router.push(`/reach/settings/whatsapp-onboarding?${params.toString()}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect WhatsApp");
    } finally {
      setLoading(false);
    }
  }

  async function runHealthCheck(connectionId: string) {
    setHealthLoadingId(connectionId);
    setError("");
    setNotice("");

    try {
      const res = await fetch(`/api/whatsapp/connections/${connectionId}/health`);
      const body = await res.json();

      if (!res.ok) {
        throw new Error(body.error || "Health check failed");
      }

      setHealthByConnectionId((prev) => ({
        ...prev,
        [connectionId]: body as ConnectionHealth,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Health check failed");
    } finally {
      setHealthLoadingId(null);
    }
  }

  async function runConnectionAction(
    connectionId: string,
    action: "refresh" | "sync_templates"
  ) {
    setActionLoadingKey(`${connectionId}:${action}`);
    setError("");
    setNotice("");

    try {
      const endpoint =
        action === "refresh"
          ? `/api/whatsapp/connections/${connectionId}/refresh`
          : `/api/whatsapp/connections/${connectionId}/templates/sync`;

      const res = await fetch(endpoint, {
        method: "POST",
      });
      const body = await res.json();

      if (!res.ok) {
        throw new Error(
          body.error ||
            (action === "refresh" ? "Failed to refresh connection" : "Failed to sync templates")
        );
      }

      setNotice(
        action === "refresh"
          ? "Connection details refreshed."
          : `Template sync completed. Synced ${body.synced || 0} WhatsApp templates.`
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActionLoadingKey(null);
    }
  }

  async function updateAccessToken(connectionId: string) {
    setTokenUpdateLoadingId(connectionId);
    setError("");
    setNotice("");

    try {
      const res = await fetch(`/api/whatsapp/connections/${connectionId}/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          accessToken: updatedAccessToken,
        }),
      });
      const body = await res.json();

      if (!res.ok) {
        throw new Error(body.error || "Failed to update access token");
      }

      setNotice(
        body.webhookSubscribed
          ? "Access token updated successfully."
          : body.webhookError || "Token updated, but webhook subscription needs attention."
      );
      setEditingTokenConnectionId(null);
      setUpdatedAccessToken("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update access token");
    } finally {
      setTokenUpdateLoadingId(null);
    }
  }

  return (
    <section className="space-y-6">
      {(error || notice) && (
        <div
          className={`rounded-lg border px-3 py-2 text-xs ${
            error
              ? "border-red-500/30 bg-red-500/10 text-red-300"
              : "border-green-500/30 bg-green-500/10 text-green-300"
          }`}
        >
          {error || notice}
        </div>
      )}

      {showSetupForm ? (
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-foreground">Connect WhatsApp Cloud API</h2>
            <p className="text-sm text-muted-foreground">
              Campaigns need a WhatsApp connection first. Add your own Meta Cloud API credentials
              to continue.
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-2 text-sm">
              <span className="text-muted-foreground">WABA ID</span>
              <input
                value={wabaId}
                onChange={(event) => setWabaId(event.target.value)}
                placeholder="WhatsApp Business Account ID"
                className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
              />
            </label>

            <label className="space-y-2 text-sm">
              <span className="text-muted-foreground">Phone Number ID</span>
              <input
                value={phoneNumberId}
                onChange={(event) => setPhoneNumberId(event.target.value)}
                placeholder="Phone Number ID from Meta"
                className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
              />
            </label>

            <label className="space-y-2 text-sm">
              <span className="text-muted-foreground">Display Number (optional)</span>
              <input
                value={phoneDisplayNumber}
                onChange={(event) => setPhoneDisplayNumber(event.target.value)}
                placeholder="+27 ..."
                className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
              />
            </label>

            <label className="space-y-2 text-sm md:col-span-2">
              <span className="text-muted-foreground">Permanent Access Token</span>
              <textarea
                value={accessToken}
                onChange={(event) => setAccessToken(event.target.value)}
                rows={4}
                placeholder="Paste your Meta system user access token"
                className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
              />
            </label>
          </div>

          <div className="mt-5 flex justify-end">
            <button
              type="button"
              onClick={connectManually}
              disabled={loading || !wabaId.trim() || !phoneNumberId.trim() || !accessToken.trim()}
              className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-60"
            >
              {loading ? "Connecting..." : "Connect WhatsApp"}
            </button>
          </div>
        </div>
      ) : mode === "maintenance" ? (
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Connect another number</h2>
              <p className="text-sm text-muted-foreground">
                Add another WhatsApp Cloud API number to this workspace without affecting the
                numbers that are already connected.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowSetupForm(true)}
              className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground"
            >
              Connect another number
            </button>
          </div>
        </div>
      ) : null}

      <div className="rounded-xl border border-border bg-card p-5">
        <h3 className="mb-3 text-sm font-semibold text-foreground">Where to get these values</h3>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            `WABA ID`: Meta App Dashboard or WhatsApp Manager for the business account you want to
            use.
          </p>
          <p>
            `Phone Number ID`: Meta App Dashboard under WhatsApp API Setup or the phone number
            details screen.
          </p>
          <p>
            `Access Token`: create a system user token in Meta Business settings with WhatsApp
            permissions for this WABA.
          </p>
          <p>
            `Webhook`: your Meta app should point messages webhooks to
            `/api/webhooks/whatsapp`, using the same `WHATSAPP_WEBHOOK_VERIFY_TOKEN` configured on
            this server.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Connected numbers</h3>
            <p className="text-sm text-muted-foreground">
              {showSetupForm
                ? "Refresh connection metadata, check webhook health, and sync templates."
                : "Maintenance tools for existing WhatsApp connections."}
            </p>
          </div>
        </div>

        {connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">No WhatsApp numbers connected yet.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-secondary/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Number</th>
                  <th className="px-3 py-2 text-left">Quality</th>
                  <th className="px-3 py-2 text-left">Verified</th>
                  <th className="px-3 py-2 text-left">Daily Limit</th>
                  <th className="px-3 py-2 text-left">Health</th>
                  <th className="px-3 py-2 text-left">Actions</th>
                </tr>
              </thead>
              <tbody>
                {connections.map((connection) => (
                  <Fragment key={connection.id}>
                    <tr className="border-t border-border">
                      <td className="px-3 py-2">
                        {connection.phoneDisplayNumber || connection.phoneNumberId}
                      </td>
                      <td className="px-3 py-2">{connection.currentQualityRating}</td>
                      <td className="px-3 py-2">{connection.verified ? "Yes" : "No"}</td>
                      <td className="px-3 py-2">{connection.dailyLimitEstimate || "-"}</td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => runHealthCheck(connection.id)}
                          className="rounded-md border border-border bg-secondary/50 px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-secondary"
                          disabled={healthLoadingId === connection.id}
                        >
                          {healthLoadingId === connection.id ? "Checking..." : "Check health"}
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => runConnectionAction(connection.id, "refresh")}
                            className="rounded-md border border-border bg-secondary/50 px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-secondary"
                            disabled={actionLoadingKey === `${connection.id}:refresh`}
                          >
                            {actionLoadingKey === `${connection.id}:refresh`
                              ? "Refreshing..."
                              : "Refresh"}
                          </button>
                          <button
                            type="button"
                            onClick={() => runConnectionAction(connection.id, "sync_templates")}
                            className="rounded-md border border-border bg-secondary/50 px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-secondary"
                            disabled={actionLoadingKey === `${connection.id}:sync_templates`}
                          >
                            {actionLoadingKey === `${connection.id}:sync_templates`
                              ? "Syncing..."
                              : "Sync templates"}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingTokenConnectionId((current) =>
                                current === connection.id ? null : connection.id
                              );
                              setUpdatedAccessToken("");
                            }}
                            className="rounded-md border border-border bg-secondary/50 px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-secondary"
                          >
                            {editingTokenConnectionId === connection.id ? "Cancel" : "Update token"}
                          </button>
                        </div>
                      </td>
                    </tr>

                    {editingTokenConnectionId === connection.id ? (
                      <tr className="border-t border-border bg-secondary/30">
                        <td className="px-3 py-3" colSpan={6}>
                          <div className="space-y-3">
                            <div>
                              <p className="text-sm font-medium text-foreground">Rotate access token</p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                Paste the new Meta system-user token for this connected number. The
                                existing connection record will be updated in place.
                              </p>
                            </div>

                            <textarea
                              value={updatedAccessToken}
                              onChange={(event) => setUpdatedAccessToken(event.target.value)}
                              rows={4}
                              placeholder="Paste your new Meta access token"
                              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground"
                            />

                            <div className="flex justify-end">
                              <button
                                type="button"
                                onClick={() => updateAccessToken(connection.id)}
                                disabled={
                                  tokenUpdateLoadingId === connection.id ||
                                  !updatedAccessToken.trim()
                                }
                                className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {tokenUpdateLoadingId === connection.id
                                  ? "Updating..."
                                  : "Save new token"}
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}

                    {healthByConnectionId[connection.id] ? (
                      <tr className="border-t border-border bg-secondary/40">
                        <td className="px-3 py-2 text-xs text-muted-foreground" colSpan={6}>
                          <p className="mb-1">
                            Overall:{" "}
                            <span
                              className={
                                healthByConnectionId[connection.id].healthy
                                  ? "text-green-300"
                                  : "text-red-300"
                              }
                            >
                              {healthByConnectionId[connection.id].healthy
                                ? "Healthy"
                                : "Needs attention"}
                            </span>
                          </p>
                          <div className="space-y-1">
                            {healthByConnectionId[connection.id].steps.map((step) => (
                              <p key={step.step}>
                                {step.step}:{" "}
                                <span className={step.ok ? "text-green-300" : "text-red-300"}>
                                  {step.ok ? "ok" : "failed"}
                                </span>{" "}
                                · {step.detail}
                              </p>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
