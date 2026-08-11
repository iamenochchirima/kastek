import WhatsappEmbeddedSignupCard from "@/components/dashboard/settings/whatsapp-embedded-signup-card";
import WhatsappManualConnectionCard from "@/components/dashboard/settings/whatsapp-manual-connection-card";
import { ConnectionsManager } from "@/components/dashboard/connections/connections-manager";
import type { WhatsappConnectionView, WorkspaceConnection } from "@/lib/connections";
import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { redirect } from "next/navigation";

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
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Connections</h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">
            Connect the external accounts your workspace uses. A connection can support Inbox,
            campaigns, agents, and social publishing according to your workspace access.
          </p>
        </div>

        {params.connected === "meta" && params.instagram_count === "0" ? (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
            Facebook connected successfully
            {params.facebook_count ? ` (${params.facebook_count} Page${params.facebook_count === "1" ? "" : "s"})` : ""},
            but Meta did not return a linked Instagram Professional account. Link the Instagram
            Business or Creator account to the selected Facebook Page, then reconnect.
          </div>
        ) : params.connected === "meta" ? (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-400">
            Meta connected successfully: {params.facebook_count ?? "0"} Facebook Page
            {params.facebook_count === "1" ? "" : "s"} and {params.instagram_count ?? "0"} Instagram
            account{params.instagram_count === "1" ? "" : "s"}.
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
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            Connection could not be completed: {params.error}
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
