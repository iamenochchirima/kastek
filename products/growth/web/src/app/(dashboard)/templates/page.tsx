import { useLoaderData, type ClientLoaderFunctionArgs } from "react-router";
import WhatsappTemplateManager from "@/components/dashboard/campaigns/whatsapp-template-manager";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "@/components/ui/page-header";
import { getWorkspaceSession } from "@/lib/core-auth";
import { fetchCoreJson } from "@/lib/core-server-api";
import { redirect } from "react-router";
import { MotionReveal } from "@/components/ui/motion-reveal";

export function meta() { return [{ title: "Templates | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

export async function clientLoader(route: ClientLoaderFunctionArgs) {
  const search = new URL(route.request.url).searchParams;
  const searchParams = (Object.fromEntries([...search.keys()].map(key => [key, search.getAll(key).length > 1 ? search.getAll(key) : search.get(key)!])) as { starter?: string; status?: string; create?: string });

  const session = await getWorkspaceSession();
  if (!session?.user?.id) throw redirect("/login");

  const params = searchParams;
  const requestedStatus = typeof params.status === "string" ? params.status.toUpperCase() : "";
  const allowedStatuses = new Set(["APPROVED", "PENDING", "REJECTED", "DISABLED"]);

  const [templateResponse, connectionResponse] = await Promise.all([
    fetchCoreJson<{
      templates: Array<{
        id: string;
        templateName: string;
        language: string;
        category: "MARKETING" | "UTILITY" | "AUTHENTICATION";
        status: "APPROVED" | "PENDING" | "REJECTED" | "DISABLED";
        variablesCount: number;
        header: string | null;
        body: string | null;
        footer: string | null;
        buttons: unknown;
        lastSynced: string | null;
        connectionLabel: string;
      }>;
    }>(`/api/whatsapp/templates${allowedStatuses.has(requestedStatus) ? `?status=${requestedStatus}` : ""}`),
    fetchCoreJson<{
      connections: Array<{
        id: string;
        phoneDisplayNumber: string | null;
        phoneNumberId: string;
      }>;
    }>("/api/whatsapp/connections"),
  ]);

  const templates = templateResponse.templates;
  const connections = connectionResponse.connections;

  return { params, templates, connections };
}

export default function ReachTemplatesPage() {
  const { params, templates, connections } = useLoaderData<typeof clientLoader>();
  return (
    <div className="min-h-[100dvh] px-4 py-6 lg:px-6">
      <div className="mx-auto max-w-[1440px] space-y-6">
        <PageHeader>
          <PageHeaderContent>
            <PageHeaderTitle>Templates</PageHeaderTitle>
            <PageHeaderDescription>WhatsApp templates</PageHeaderDescription>
          </PageHeaderContent>
        </PageHeader>

        {connections.length === 0 ? (
          <MotionReveal delay={0.08}>
          <div className="rounded-xl border border-dashed border-border bg-card p-8 text-sm text-muted-foreground">
            Connect a WhatsApp number first before managing templates.
          </div>
          </MotionReveal>
        ) : (
          <MotionReveal delay={0.08}>
            <WhatsappTemplateManager
              connections={connections}
              forceCreateForm={params.create === "1"}
              initialLibraryItemId={params.starter}
              templates={templates}
            />
          </MotionReveal>
        )}
      </div>
    </div>
  );
}
