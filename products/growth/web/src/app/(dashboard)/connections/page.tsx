import { useLoaderData, type ClientLoaderFunctionArgs } from "react-router";
import WhatsappEmbeddedSignupCard from "@/components/dashboard/settings/whatsapp-embedded-signup-card";
import WhatsappManualConnectionCard from "@/components/dashboard/settings/whatsapp-manual-connection-card";
import { ConnectionsManager } from "@/components/dashboard/connections/connections-manager";
import type { WhatsappConnectionView, WorkspaceConnection } from "@/lib/connections";
import { getWorkspaceSession } from "@/lib/core-auth";
import { fetchCoreJson } from "@/lib/core-server-api";
import { redirect } from "react-router";
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/ui/page-header";
import { CONNECTION_ANALYTICS_METRICS, FeatureAnalyticsPanel } from "@/components/analytics/feature-analytics-panel";

export function meta() { return [{ title: "Connections | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

export async function clientLoader(route: ClientLoaderFunctionArgs) {
  const search = new URL(route.request.url).searchParams;
  const searchParams = (Object.fromEntries([...search.keys()].map(key => [key, search.getAll(key).length > 1 ? search.getAll(key) : search.get(key)!])) as {
    connected?: string;
    facebook_count?: string;
    instagram_count?: string;
    pages_count?: string;
    pages_status?: string;
    error?: string;
    access?: string;
    provider?: string;
    connectionId?: string;
    capabilities?: string;
  });

  const session = await getWorkspaceSession(route.request);
  if (!session?.user?.id) throw redirect("/login");

  const params = searchParams;
  const requestedCapabilities = params.capabilities?.split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);

  const [sharedResponse, whatsappResponse] = await Promise.all([
    fetchCoreJson<{ connections: WorkspaceConnection[] }>("/api/connections")
      .then((response) => ({ ...response, loadFailed: false }))
      .catch(() => ({ connections: [], loadFailed: true })),
    fetchCoreJson<{ connections: WhatsappConnectionView[] }>("/api/whatsapp/connections").catch(() => ({ connections: [] })),
  ]);

  return { params, requestedCapabilities, sharedResponse, whatsappResponse };
}

export default function ConnectionsPage() {
  const { params, requestedCapabilities, sharedResponse, whatsappResponse } = useLoaderData<typeof clientLoader>();
  return (
    <div className="min-h-[100dvh] p-4 sm:p-6">
      <div className="mx-auto max-w-[1440px] space-y-6">
        <PageHeader>
          <PageHeaderContent>
            <PageHeaderTitle>Connections</PageHeaderTitle>
            <PageHeaderDescription>Connected workspace accounts.</PageHeaderDescription>
          </PageHeaderContent>
        </PageHeader>

        {params.connected === "meta" && params.instagram_count === "0" ? (
          <div className="flex items-start justify-between gap-3 rounded-xl border border-status-attention/30 bg-status-attention-soft px-4 py-3 text-sm text-status-attention">
            <span>
              Facebook connected successfully
              {params.facebook_count ? ` (${params.facebook_count} Page${params.facebook_count === "1" ? "" : "s"})` : ""},
              but Meta did not return a linked Instagram Professional account. Link the Instagram
              Business or Creator account to the selected Facebook Page, then reconnect.
            </span>
            <a href="/connections" className="shrink-0 text-lg leading-none" aria-label="Dismiss message">×</a>
          </div>
        ) : params.connected === "meta" ? (
          <div className="flex items-start justify-between gap-3 rounded-xl border border-status-success/30 bg-status-success-soft px-4 py-3 text-sm text-status-success">
            <span>
              Meta connected successfully: {params.facebook_count ?? "0"} Facebook Page
              {params.facebook_count === "1" ? "" : "s"} and {params.instagram_count ?? "0"} Instagram
              account{params.instagram_count === "1" ? "" : "s"}.
            </span>
            <a href="/connections" className="shrink-0 text-lg leading-none" aria-label="Dismiss message">×</a>
          </div>
        ) : null}

        {params.connected === "instagram" ||
        params.connected === "threads" ||
        params.connected === "tiktok" ||
        params.connected === "linkedin" ||
        params.connected === "x" ? (
          <div className="rounded-xl border border-status-success/30 bg-status-success-soft px-4 py-3 text-sm text-status-success">
            {params.connected === "linkedin" && params.pages_count ? (
              params.pages_status === "unavailable" ? (
                <>LinkedIn profile connected. Company Pages are unavailable until organization access is enabled.</>
              ) : params.pages_count === "0" ? (
                <>LinkedIn profile connected. No Company Pages were found for this account.</>
              ) : (
                <>LinkedIn connected successfully: profile and {params.pages_count} Company Page{params.pages_count === "1" ? "" : "s"} ready to use in this workspace.</>
              )
            ) : (
              <>Your{" "}
              {params.connected === "instagram"
              ? "Instagram"
              : params.connected === "threads"
                ? "Threads"
                : params.connected === "tiktok"
                  ? "TikTok"
                  : params.connected === "linkedin"
                    ? "LinkedIn profile"
                    : "X"}{" "}
              {params.connected === "linkedin" ? " was connected" : " account was connected"} and is ready to use in this workspace.</>
            )}
          </div>
        ) : null}

        {params.error ? (
          <div className="flex items-start justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <span>Connection could not be completed: {params.error}</span>
            <a href="/connections" className="shrink-0 text-lg leading-none" aria-label="Dismiss message">×</a>
          </div>
        ) : null}

        {params.access === "granted" ? (
          <div className="rounded-xl border border-status-success/30 bg-status-success-soft px-4 py-3 text-sm text-status-success">
            Connection access updated.
          </div>
        ) : null}

        <FeatureAnalyticsPanel title="Connection" description="Lifecycle and health reporting." metricKeys={CONNECTION_ANALYTICS_METRICS} />

        <WhatsappEmbeddedSignupCard
          connections={whatsappResponse.connections}
          hidden
          accessRequest={params.access === "required" ? {
            connectionId: params.connectionId,
            capabilities: requestedCapabilities,
          } : undefined}
        />

        <ConnectionsManager
          connections={sharedResponse.connections}
          loadFailed={sharedResponse.loadFailed}
          initialAccessRequest={params.connectionId ? {
            connectionId: params.connectionId,
            capabilities: requestedCapabilities,
            provider: params.provider,
          } : params.provider ? {
            capabilities: requestedCapabilities,
            provider: params.provider,
          } : undefined}
        />

        <section id="whatsapp-setup" className="scroll-mt-6 space-y-3">
          <details className="rounded-xl border border-border bg-card">
            <summary className="cursor-pointer px-5 py-4 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              Advanced: connect with existing Meta credentials
            </summary>
            <div className="border-t border-border p-5">
              <p className="mb-4 text-sm text-muted-foreground">
                Use this only if you cannot complete Meta Embedded Signup. Most workspaces should
                connect through the Meta flow above.
              </p>
              <WhatsappManualConnectionCard connections={whatsappResponse.connections} mode="setup" />
            </div>
          </details>
        </section>
      </div>
    </div>
  );
}
