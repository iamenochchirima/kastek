import WhatsappEmbeddedSignupCard from "@/components/dashboard/settings/whatsapp-embedded-signup-card";
import WhatsappManualConnectionCard from "@/components/dashboard/settings/whatsapp-manual-connection-card";
import { ConnectionsManager } from "@/components/dashboard/connections/connections-manager";
import type { WhatsappConnectionView, WorkspaceConnection } from "@/lib/connections";
import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { redirect } from "next/navigation";
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/ui/page-header";

export const metadata = {
  title: "Connections | KasiTek",
};

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    connected?: string;
    facebook_count?: string;
    instagram_count?: string;
    error?: string;
  }>;
}) {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");

  const params = await searchParams;

  const [sharedResponse, whatsappResponse] = await Promise.all([
    fetchRustJson<{ connections: WorkspaceConnection[] }>("/api/connections").catch(() => ({ connections: [] })),
    fetchRustJson<{ connections: WhatsappConnectionView[] }>("/api/whatsapp/connections").catch(() => ({ connections: [] })),
  ]);

  return (
    <div className="min-h-screen p-4 sm:p-6">
      <div className="mx-auto max-w-[1440px] space-y-6">
        <PageHeader>
          <PageHeaderContent>
            <PageHeaderTitle>Connections</PageHeaderTitle>
            <PageHeaderDescription>Connected workspace accounts.</PageHeaderDescription>
          </PageHeaderContent>
        </PageHeader>

        {params.connected === "meta" && params.instagram_count === "0" ? (
          <div className="flex items-start justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
            <span>
              Facebook connected successfully
              {params.facebook_count ? ` (${params.facebook_count} Page${params.facebook_count === "1" ? "" : "s"})` : ""},
              but Meta did not return a linked Instagram Professional account. Link the Instagram
              Business or Creator account to the selected Facebook Page, then reconnect.
            </span>
            <a href="/connections" className="shrink-0 text-lg leading-none" aria-label="Dismiss message">×</a>
          </div>
        ) : params.connected === "meta" ? (
          <div className="flex items-start justify-between gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-400">
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
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-400">
            Your{" "}
            {params.connected === "instagram"
              ? "Instagram"
              : params.connected === "threads"
                ? "Threads"
                : params.connected === "tiktok"
                  ? "TikTok"
              : params.connected === "linkedin"
                ? "LinkedIn"
                : "X"}{" "}
            account was connected and is ready to use in this workspace.
          </div>
        ) : null}

        {params.error ? (
          <div className="flex items-start justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <span>Connection could not be completed: {params.error}</span>
            <a href="/connections" className="shrink-0 text-lg leading-none" aria-label="Dismiss message">×</a>
          </div>
        ) : null}

        <WhatsappEmbeddedSignupCard connections={whatsappResponse.connections} hidden />

        <ConnectionsManager connections={sharedResponse.connections} />

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
