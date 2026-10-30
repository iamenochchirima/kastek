import { redirect, useLoaderData, type ClientLoaderFunctionArgs } from "react-router";
import WhatsappTemplateManager, { type TemplateView } from "@/components/dashboard/campaigns/whatsapp-template-manager";
import { queryClient, requestScope } from "@/lib/query-client";
import { getWorkspaceSession } from "@/lib/core-auth";
import { ApiError, fetchCoreJson } from "@/lib/core-server-api";

export function meta() { return [{ title: "Templates | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

export async function clientLoader(route: ClientLoaderFunctionArgs) {
  const search = new URL(route.request.url).searchParams;
  const session = await getWorkspaceSession(route.request);
  if (!session?.user?.id) throw redirect("/login");
  const requestedStatus = search.get("status")?.toUpperCase() || "";
  const status = ["APPROVED", "PENDING", "REJECTED", "DISABLED"].includes(requestedStatus) ? requestedStatus : "all";
  const [templateResponse, connectionResponse] = await Promise.allSettled([
    fetchCoreJson<{ templates: TemplateView[] }>("/api/whatsapp/templates"),
    fetchCoreJson<{ connections: Array<{ id: string; phoneDisplayNumber: string | null; phoneNumberId: string }> }>("/api/whatsapp/connections"),
  ]);
  const cachedTemplates = queryClient.getQueryData<{ templates: TemplateView[] }>(["growth", requestScope(), "/api/whatsapp/templates", []]);
  return {
    status,
    starter: search.get("starter") || undefined,
    create: search.get("create") === "1",
    templates: templateResponse.status === "fulfilled" ? templateResponse.value.templates : templateResponse.reason instanceof ApiError && [401, 403].includes(templateResponse.reason.status) ? [] : cachedTemplates?.templates || [],
    connections: connectionResponse.status === "fulfilled" ? connectionResponse.value.connections : [],
    templatesError: templateResponse.status === "rejected" ? unavailableMessage(templateResponse.reason, "Templates") : null,
    connectionsError: connectionResponse.status === "rejected" ? unavailableMessage(connectionResponse.reason, "WhatsApp accounts") : null,
  };
}

export default function ReachTemplatesPage() {
  const data = useLoaderData<typeof clientLoader>();
  return <WhatsappTemplateManager connections={data.connections} templates={data.templates} initialStatus={data.status} initialLibraryItemId={data.starter} forceCreateForm={data.create} templatesError={data.templatesError} connectionsError={data.connectionsError} />;
}

function unavailableMessage(error: unknown, resource: string) {
  return error instanceof ApiError && error.status === 403 ? `${resource}: access denied` : `${resource} unavailable`;
}
