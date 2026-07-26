"use client";

import { apiUrl } from "@/lib/server-api";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
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

type EmbeddedSignupFinishData = {
  wabaId?: string;
  phoneNumberId?: string;
};

type FbAuthResponse = {
  code?: string;
};

type FbLoginResponse = {
  authResponse?: FbAuthResponse;
  status?: string;
};

type FbSdk = {
  init: (config: Record<string, unknown>) => void;
  login: (
    callback: (response: FbLoginResponse) => void,
    options: Record<string, unknown>
  ) => void;
};

declare global {
  interface Window {
    FB?: FbSdk;
    fbAsyncInit?: () => void;
  }
}

const SDK_SRC = "https://connect.facebook.net/en_US/sdk.js";

function parseEmbeddedSignupMessage(rawData: unknown):
  | { type: "FINISH"; data: EmbeddedSignupFinishData }
  | { type: "CANCEL"; data?: Record<string, unknown> }
  | { type: "ERROR"; data?: Record<string, unknown> }
  | null {
  let payload: unknown = rawData;

  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }

  if (!payload || typeof payload !== "object") return null;

  const root = payload as {
    type?: string;
    event?: string;
    data?: Record<string, unknown>;
  };

  if (root.type !== "WA_EMBEDDED_SIGNUP") return null;

  const event = root.event || "";
  const data = root.data || {};

  if (event === "FINISH") {
    return {
      type: "FINISH",
      data: {
        wabaId:
          (typeof data.waba_id === "string" ? data.waba_id : undefined) ||
          (typeof data.wabaId === "string" ? data.wabaId : undefined),
        phoneNumberId:
          (typeof data.phone_number_id === "string" ? data.phone_number_id : undefined) ||
          (typeof data.phoneNumberId === "string" ? data.phoneNumberId : undefined),
      },
    };
  }

  if (event === "CANCEL") {
    return { type: "CANCEL", data };
  }

  if (event === "ERROR") {
    return { type: "ERROR", data };
  }

  return null;
}

export default function WhatsappEmbeddedSignupCard({
  connections,
}: {
  connections: WhatsappConnectionView[];
}) {
  const router = useRouter();
  const [sdkReady, setSdkReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [healthLoadingId, setHealthLoadingId] = useState<string | null>(null);
  const [actionLoadingKey, setActionLoadingKey] = useState<string | null>(null);
  const [healthByConnectionId, setHealthByConnectionId] = useState<
    Record<string, ConnectionHealth>
  >({});

  const finishDataRef = useRef<EmbeddedSignupFinishData | null>(null);
  const startSignupRef = useRef<() => void>(() => undefined);

  const appId = process.env.NEXT_PUBLIC_META_APP_ID || "";
  const configId = process.env.NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID || "";

  const envMissing = useMemo(() => {
    const missing: string[] = [];
    if (!appId) missing.push("NEXT_PUBLIC_META_APP_ID");
    if (!configId) missing.push("NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID");
    return missing;
  }, [appId, configId]);

  useEffect(() => {
    if (envMissing.length > 0) return;

    let cancelled = false;

    const existing = document.querySelector(`script[src=\"${SDK_SRC}\"]`);
    if (!existing) {
      const script = document.createElement("script");
      script.src = SDK_SRC;
      script.async = true;
      script.defer = true;
      document.body.appendChild(script);
    }

    window.fbAsyncInit = () => {
      if (!window.FB || cancelled) return;

      window.FB.init({
        appId,
        autoLogAppEvents: true,
        xfbml: false,
        version: "v19.0",
      });

      setSdkReady(true);
    };

    const onMessage = (event: MessageEvent) => {
      if (!event.origin.includes("facebook.com")) return;
      const parsed = parseEmbeddedSignupMessage(event.data);
      if (!parsed) return;

      if (parsed.type === "FINISH") {
        finishDataRef.current = parsed.data;
        setNotice("WhatsApp account selected. Finalizing connection...");
      }

      if (parsed.type === "CANCEL") {
        setNotice("Embedded signup canceled.");
      }

      if (parsed.type === "ERROR") {
        setError("Embedded signup reported an error. Please try again.");
      }
    };

    window.addEventListener("message", onMessage);

    return () => {
      cancelled = true;
      window.removeEventListener("message", onMessage);
    };
  }, [appId, envMissing.length]);

  async function finalizeSignup(code: string) {
    const finishData = finishDataRef.current;

    const res = await fetch(apiUrl("/api/whatsapp/onboarding/complete"), {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code,
        wabaId: finishData?.wabaId,
        phoneNumberId: finishData?.phoneNumberId,
      }),
    });

    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.error || "Failed to complete WhatsApp onboarding");
    }

    const diagnostics = JSON.stringify(body.diagnostics || []);
    const message = body.webhookSubscribed
      ? "WhatsApp Business connected successfully."
      : body.webhookError ||
        "Connection saved, but webhook subscription needs attention.";

    const params = new URLSearchParams({
      status: "success",
      message,
      diagnostics,
      connectionId: body.connection?.id || "",
      number: body.connection?.phoneDisplayNumber || body.connection?.phoneNumberId || "",
      templates: String(body.templateSync?.synced || 0),
    });

    router.push(`/connections/whatsapp-onboarding?${params.toString()}`);
  }

  async function runHealthCheck(connectionId: string) {
    setHealthLoadingId(connectionId);
    setError("");
    setNotice("");

    try {
      const res = await fetch(apiUrl(`/api/whatsapp/connections/${connectionId}/health`), {
        credentials: "include",
      });
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

      const res = await fetch(apiUrl(endpoint), {
        method: "POST",
        credentials: "include",
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

  function startEmbeddedSignup() {
    setError("");
    setNotice("");
    finishDataRef.current = null;

    if (envMissing.length > 0) {
      setError(`Missing env vars: ${envMissing.join(", ")}`);
      return;
    }

    if (!window.FB) {
      setError("Meta SDK is not ready. Refresh and try again.");
      return;
    }

    setLoading(true);

    window.FB.login(
      (response) => {
        const code = response.authResponse?.code;

        if (!code) {
          setLoading(false);
          setError("Meta did not return an authorization code.");
          return;
        }

        void finalizeSignup(code)
          .catch((err) => {
            const message = err instanceof Error ? err.message : "Failed to connect WhatsApp";
            const params = new URLSearchParams({
              status: "error",
              message,
              diagnostics: JSON.stringify([
                {
                  step: "finalize_signup",
                  ok: false,
                  detail: message,
                },
              ]),
            });
            router.push(`/connections/whatsapp-onboarding?${params.toString()}`);
          })
          .finally(() => {
            setLoading(false);
          });
      },
      {
        config_id: configId,
        response_type: "code",
        override_default_response_type: true,
        extras: {
          setup: {},
        },
      }
    );
  }

  startSignupRef.current = startEmbeddedSignup;

  useEffect(() => {
    const handleStart = () => startSignupRef.current();
    window.addEventListener("kasitek:start-whatsapp-embedded-signup", handleStart);
    return () => window.removeEventListener("kasitek:start-whatsapp-embedded-signup", handleStart);
  }, []);

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">WhatsApp Business</h2>
          <p className="text-sm text-muted-foreground">
            Connect a WhatsApp Business Account using Meta Embedded Signup.
          </p>
        </div>

        <button
          type="button"
          onClick={startEmbeddedSignup}
          disabled={loading || !sdkReady || envMissing.length > 0}
          className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-all hover:-translate-y-0.5 hover:bg-primary/90 disabled:opacity-60 disabled:hover:translate-y-0"
        >
          {loading ? "Connecting..." : connections.length ? "Connect Another" : "Connect WhatsApp"}
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-destructive/30 bg-status-danger-soft px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {notice && (
        <div className="mb-3 rounded-lg border border-status-success/30 bg-status-success-soft px-3 py-2 text-xs text-status-success">
          {notice}
        </div>
      )}

      {envMissing.length > 0 && (
        <p className="mb-3 text-xs text-status-attention">
          Configure: {envMissing.join(", ")} in your env file.
        </p>
      )}

      {connections.length === 0 ? (
        <p className="text-sm text-muted-foreground">No WhatsApp numbers connected yet.</p>
      ) : (
        <>
        <div className="space-y-3 md:hidden">
          {connections.map((connection) => (
            <Fragment key={connection.id}>
              <div className="rounded-xl border border-border bg-secondary/20 p-4">
                <div>
                  <p className="font-medium text-foreground">
                    {connection.phoneDisplayNumber || connection.phoneNumberId}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Quality: {connection.currentQualityRating} · Verified: {connection.verified ? "Yes" : "No"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Daily limit: {connection.dailyLimitEstimate || "-"}
                  </p>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => runHealthCheck(connection.id)}
                    className="rounded-md border border-border px-2.5 py-1 text-xs text-foreground hover:border-primary/20"
                    disabled={healthLoadingId === connection.id}
                  >
                    {healthLoadingId === connection.id ? "Checking..." : "Check health"}
                  </button>
                  <button
                    type="button"
                    onClick={() => runConnectionAction(connection.id, "refresh")}
                    className="rounded-md border border-border px-2.5 py-1 text-xs text-foreground hover:border-primary/20"
                    disabled={actionLoadingKey === `${connection.id}:refresh`}
                  >
                    {actionLoadingKey === `${connection.id}:refresh` ? "Refreshing..." : "Refresh"}
                  </button>
                  <button
                    type="button"
                    onClick={() => runConnectionAction(connection.id, "sync_templates")}
                    className="rounded-md border border-border px-2.5 py-1 text-xs text-foreground hover:border-primary/20"
                    disabled={actionLoadingKey === `${connection.id}:sync_templates`}
                  >
                    {actionLoadingKey === `${connection.id}:sync_templates` ? "Syncing..." : "Sync templates"}
                  </button>
                </div>
                {healthByConnectionId[connection.id] ? (
                  <div className="mt-3 space-y-1 rounded-lg border border-border bg-background/40 p-3 text-xs text-muted-foreground">
                    <p>
                      Overall:{" "}
                      <span
                        className={
                          healthByConnectionId[connection.id].healthy ? "text-status-success" : "text-destructive"
                        }
                      >
                        {healthByConnectionId[connection.id].healthy ? "Healthy" : "Needs attention"}
                      </span>
                    </p>
                    {healthByConnectionId[connection.id].steps.map((step) => (
                      <p key={step.step}>
                        {step.step}:{" "}
                        <span className={step.ok ? "text-status-success" : "text-destructive"}>
                          {step.ok ? "ok" : "failed"}
                        </span>{" "}
                        · {step.detail}
                      </p>
                    ))}
                  </div>
                ) : null}
              </div>
            </Fragment>
          ))}
        </div>

        <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
          <table className="w-full text-sm">
            <thead className="bg-secondary/40 text-muted-foreground">
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
                        className="rounded-md border border-border px-2.5 py-1 text-xs text-foreground hover:border-primary/20"
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
                          className="rounded-md border border-border px-2.5 py-1 text-xs text-foreground hover:border-primary/20"
                          disabled={actionLoadingKey === `${connection.id}:refresh`}
                        >
                          {actionLoadingKey === `${connection.id}:refresh`
                            ? "Refreshing..."
                            : "Refresh"}
                        </button>
                        <button
                          type="button"
                          onClick={() => runConnectionAction(connection.id, "sync_templates")}
                          className="rounded-md border border-border px-2.5 py-1 text-xs text-foreground hover:border-primary/20"
                          disabled={actionLoadingKey === `${connection.id}:sync_templates`}
                        >
                          {actionLoadingKey === `${connection.id}:sync_templates`
                            ? "Syncing..."
                            : "Sync templates"}
                        </button>
                      </div>
                    </td>
                  </tr>

                  {healthByConnectionId[connection.id] ? (
                    <tr className="border-t border-border bg-secondary/30">
                      <td className="px-3 py-2 text-xs text-muted-foreground" colSpan={6}>
                        <p className="mb-1">
                          Overall:{" "}
                          <span
                            className={
                              healthByConnectionId[connection.id].healthy
                                ? "text-status-success"
                                : "text-destructive"
                            }
                          >
                            {healthByConnectionId[connection.id].healthy ? "Healthy" : "Needs attention"}
                          </span>
                        </p>
                        <div className="space-y-1">
                          {healthByConnectionId[connection.id].steps.map((step) => (
                            <p key={step.step}>
                              {step.step}:{" "}
                              <span className={step.ok ? "text-status-success" : "text-destructive"}>
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
        </>
      )}
    </section>
  );
}
