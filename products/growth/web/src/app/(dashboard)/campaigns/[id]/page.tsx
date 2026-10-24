import { useLoaderData, type ClientLoaderFunctionArgs } from "react-router";
import CampaignDetailPageClient from "@/components/dashboard/campaigns/campaign-detail-page-client";
import { getWorkspaceSession } from "@/lib/core-auth";
import { ApiError, fetchCoreJson } from "@/lib/core-server-api";
import { redirect } from "react-router";

export function meta() { return [{ title: "Campaign Details | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

type CampaignDetailResponse = {
  campaign?: {
    campaign: {
      id: string;
      name: string;
      description: string | null;
      templateName: string;
      template_name?: string;
      templateLanguage: string;
      template_language?: string;
      variableMappings?: Array<{ source?: string; key?: string }> | null;
      variable_mappings?: Array<{ source?: string; key?: string }> | null;
      templateHeader?: string | null;
      template_header?: string | null;
      templateBody?: string | null;
      template_body?: string | null;
      templateFooter?: string | null;
      template_footer?: string | null;
      templateButtons?: unknown[] | null;
      template_buttons?: unknown[] | null;
      status: string;
      scheduledAt: string | null;
      scheduled_at?: string | null;
      launchedAt: string | null;
      launched_at?: string | null;
      completedAt: string | null;
      completed_at?: string | null;
      totalRecipients: number;
      total_recipients?: number;
      sentCount: number;
      sent_count?: number;
      deliveredCount: number;
      delivered_count?: number;
      readCount: number;
      read_count?: number;
      failedCount: number;
      failed_count?: number;
      blockedCount: number;
      blocked_count?: number;
      unsubscribedCount: number;
      unsubscribed_count?: number;
      createdAt: string;
      created_at?: string;
      updatedAt: string;
      updated_at?: string;
      connectionLabel: string | null;
      connection_label?: string | null;
      templateStatus: string | null;
      template_status?: string | null;
      listLabel: string | null;
      list_label?: string | null;
      defaultBatchSize: number | null;
      default_batch_size?: number | null;
    };
    recipients: Array<{
      id: string;
      contactId: string;
      contact_id?: string;
      status: string;
      waMessageId: string | null;
      wa_message_id?: string | null;
      sentAt: string | null;
      sent_at?: string | null;
      deliveredAt: string | null;
      delivered_at?: string | null;
      readAt: string | null;
      read_at?: string | null;
      failedAt: string | null;
      failed_at?: string | null;
      errorCode: string | null;
      error_code?: string | null;
      errorMessage: string | null;
      error_message?: string | null;
      createdAt: string;
      created_at?: string;
      updatedAt: string;
      updated_at?: string;
      contactPhone: string;
      contact_phone?: string;
      contactFullName: string | null;
      contact_full_name?: string | null;
      contactLocation: string | null;
      contact_location?: string | null;
      contactListLabel: string;
      contact_list_label?: string;
      contactMetadata?: Record<string, string> | null;
      contact_metadata?: Record<string, string> | null;
    }>;
  };
};

export async function clientLoader(route: ClientLoaderFunctionArgs) {
  const params = (route.params as { id: string });

  const session = await getWorkspaceSession();
  if (!session?.user?.id) throw redirect("/login");

  const { id } = params;

  const response: CampaignDetailResponse | null = await fetchCoreJson<CampaignDetailResponse>(
    `/api/whatsapp/campaigns/${id}`,
  ).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) throw new Response("Not found", { status: 404 });
    throw error;
  });

  if (!response?.campaign) {
    throw new Response("Not found", { status: 404 });
  }

  const campaign = response.campaign.campaign;

  return { recipients: response.campaign.recipients, campaign };
}

export default function ReachCampaignDetailPage() {
  const { recipients, campaign } = useLoaderData<typeof clientLoader>();
  return (
    <CampaignDetailPageClient
      campaign={{
        id: campaign.id,
        name: campaign.name,
        description: campaign.description,
        templateName: campaign.templateName ?? campaign.template_name ?? "",
        templateLanguage: campaign.templateLanguage ?? campaign.template_language ?? "",
        variableMappings: campaign.variableMappings ?? campaign.variable_mappings ?? null,
        templateHeader: campaign.templateHeader ?? campaign.template_header ?? null,
        templateBody: campaign.templateBody ?? campaign.template_body ?? null,
        templateFooter: campaign.templateFooter ?? campaign.template_footer ?? null,
        templateButtons: campaign.templateButtons ?? campaign.template_buttons ?? null,
        status: campaign.status,
        scheduledAt: campaign.scheduledAt ?? campaign.scheduled_at ?? null,
        launchedAt: campaign.launchedAt ?? campaign.launched_at ?? null,
        completedAt: campaign.completedAt ?? campaign.completed_at ?? null,
        totalRecipients: Number(campaign.totalRecipients ?? campaign.total_recipients ?? 0),
        sentCount: Number(campaign.sentCount ?? campaign.sent_count ?? 0),
        deliveredCount: Number(campaign.deliveredCount ?? campaign.delivered_count ?? 0),
        readCount: Number(campaign.readCount ?? campaign.read_count ?? 0),
        failedCount: Number(campaign.failedCount ?? campaign.failed_count ?? 0),
        blockedCount: Number(campaign.blockedCount ?? campaign.blocked_count ?? 0),
        unsubscribedCount: Number(campaign.unsubscribedCount ?? campaign.unsubscribed_count ?? 0),
        createdAt: campaign.createdAt ?? campaign.created_at,
        updatedAt: campaign.updatedAt ?? campaign.updated_at,
        connectionLabel: campaign.connectionLabel ?? campaign.connection_label ?? null,
        templateStatus: campaign.templateStatus ?? campaign.template_status ?? null,
        listLabel: campaign.listLabel ?? campaign.list_label ?? null,
        defaultBatchSize: campaign.defaultBatchSize ?? campaign.default_batch_size ?? null,
      }}
      recipients={(recipients ?? []).map((recipient) => ({
        id: recipient.id,
        contactId: recipient.contactId ?? recipient.contact_id ?? "",
        status: recipient.status,
        waMessageId: recipient.waMessageId ?? recipient.wa_message_id ?? null,
        sentAt: recipient.sentAt ?? recipient.sent_at ?? null,
        deliveredAt: recipient.deliveredAt ?? recipient.delivered_at ?? null,
        readAt: recipient.readAt ?? recipient.read_at ?? null,
        failedAt: recipient.failedAt ?? recipient.failed_at ?? null,
        errorCode: recipient.errorCode ?? recipient.error_code ?? null,
        errorMessage: recipient.errorMessage ?? recipient.error_message ?? null,
        createdAt: recipient.createdAt ?? recipient.created_at ?? "",
        updatedAt: recipient.updatedAt ?? recipient.updated_at ?? "",
        contactPhone: recipient.contactPhone ?? recipient.contact_phone ?? "",
        contactFullName: recipient.contactFullName ?? recipient.contact_full_name ?? null,
        contactLocation: recipient.contactLocation ?? recipient.contact_location ?? null,
        contactListLabel: recipient.contactListLabel ?? recipient.contact_list_label ?? "default",
        contactMetadata: recipient.contactMetadata ?? recipient.contact_metadata ?? null,
      }))}
    />
  );
}
