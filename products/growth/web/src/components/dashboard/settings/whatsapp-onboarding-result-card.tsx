import { Link } from "react-router";
import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "@/components/ui/page-header";

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
    validate_phone: "Validate Phone Number",
    save_connection: "Save Connection",
    subscribe_webhook: "Subscribe Webhook",
    sync_templates: "Sync Templates",
  };

  return mapping[step] || step;
}

export default function WhatsappOnboardingResultCard() {
  const [searchParams] = useSearchParams();

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
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div
        className={`rounded-xl border p-5 ${
          ok
            ? "border-status-success/30 bg-status-success-soft"
            : "border-destructive/30 bg-status-danger-soft"
        }`}
      >
        <PageHeader><PageHeaderContent><PageHeaderTitle>{ok ? "WhatsApp connected" : "WhatsApp connection error"}</PageHeaderTitle><PageHeaderDescription>{message}</PageHeaderDescription></PageHeaderContent></PageHeader>

        {ok && (
          <div className="mt-3 text-sm text-foreground">
            <p>Number: {number || "-"}</p>
            <p>Templates synced: {templates}</p>
            {connectionId ? (
              <p>
                Connection ID: <span className="text-muted-foreground">{connectionId}</span>
              </p>
            ) : null}
          </div>
        )}
      </div>

      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-3 text-sm font-semibold">Step-by-step diagnostics</h2>

        {diagnostics.length === 0 ? (
          <p className="text-sm text-muted-foreground">No diagnostics were captured.</p>
        ) : (
          <div className="space-y-2">
            {diagnostics.map((item, index) => (
              <div
                key={`${item.step}-${index}`}
                className="rounded-lg border border-border bg-secondary/40 p-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">{label(item.step)}</p>
                  <span
                    className={`text-xs font-semibold ${item.ok ? "text-status-success" : "text-destructive"}`}
                  >
                    {item.ok ? "OK" : "FAILED"}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{item.detail}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="flex justify-end">
        <Button asChild><Link to="/connections">Finish</Link></Button>
      </div>
    </div>
  );
}
