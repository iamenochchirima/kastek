"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useSearchParams } from "next/navigation";

type Diagnostic = {
  step: string;
  ok: boolean;
  detail: string;
};

function label(step: string) {
  const mapping: Record<string, string> = {
    exchange_code: "Code Exchange",
    resolve_waba: "Resolve Business Account",
    resolve_phone: "Resolve Phone Number",
    save_connection: "Save Connection",
    subscribe_webhook: "Subscribe Webhook",
    sync_templates: "Sync Templates",
  };

  return mapping[step] || step;
}

export default function WhatsappOnboardingResultCard() {
  const searchParams = useSearchParams();

  const status = searchParams.get("status") || "error";
  const message = searchParams.get("message") || "Onboarding did not complete.";
  const connectionId = searchParams.get("connectionId") || "";
  const number = searchParams.get("number") || "";
  const templates = Number(searchParams.get("templates") || "0");

  const diagnostics = useMemo(() => {
    const encoded = searchParams.get("diagnostics");
    if (!encoded) return [] as Diagnostic[];

    try {
      const parsed = JSON.parse(encoded) as Diagnostic[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      try {
        const parsed = JSON.parse(decodeURIComponent(encoded)) as Diagnostic[];
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [] as Diagnostic[];
      }
    }
  }, [searchParams]);

  const ok = status === "success";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div
        className={`rounded-xl border p-5 ${
          ok
            ? "border-green-500/30 bg-green-500/10"
            : "border-red-500/30 bg-red-500/10"
        }`}
      >
        <h1 className="mb-2 font-serif text-3xl">
          {ok ? "WhatsApp Connected" : "WhatsApp Onboarding Error"}
        </h1>
        <p className="text-sm text-text-muted">{message}</p>

        {ok && (
          <div className="mt-3 text-sm text-text">
            <p>Number: {number || "-"}</p>
            <p>Templates synced: {templates}</p>
            {connectionId ? (
              <p>
                Connection ID: <span className="text-text-muted">{connectionId}</span>
              </p>
            ) : null}
          </div>
        )}
      </div>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-3 text-sm font-semibold">Step-by-step diagnostics</h2>

        {diagnostics.length === 0 ? (
          <p className="text-sm text-text-muted">No diagnostics were captured.</p>
        ) : (
          <div className="space-y-2">
            {diagnostics.map((item, index) => (
              <div
                key={`${item.step}-${index}`}
                className="rounded-lg border border-border bg-surface-2 p-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">{label(item.step)}</p>
                  <span
                    className={`text-xs font-semibold ${item.ok ? "text-green-300" : "text-red-300"}`}
                  >
                    {item.ok ? "OK" : "FAILED"}
                  </span>
                </div>
                <p className="mt-1 text-xs text-text-muted">{item.detail}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="flex flex-wrap gap-3">
        <Link
          href="/dashboard/settings"
          className="rounded-lg border border-border px-4 py-2 text-sm text-text no-underline hover:border-border-light"
        >
          Back to Settings
        </Link>
        <Link
          href="/dashboard/campaigns/new"
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg no-underline"
        >
          Go to Campaigns
        </Link>
      </div>
    </div>
  );
}
