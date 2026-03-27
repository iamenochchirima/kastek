"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { apiUrl } from "@/lib/server-api";
import type { WhatsappRealtimeEvent } from "@/lib/whatsapp/types";
import Link from "next/link";
import { useEffect, useEffectEvent, useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";

type Campaign = {
  id: string;
  name: string;
  description: string | null;
  templateName: string;
  templateLanguage: string;
  variableMappings: TemplateVariableMapping[] | null;
  templateHeader: string | null;
  templateBody: string | null;
  templateFooter: string | null;
  templateButtons: unknown[] | null;
  status: string;
  scheduledAt: string | null;
  launchedAt: string | null;
  completedAt: string | null;
  totalRecipients: number;
  sentCount: number;
  deliveredCount: number;
  readCount: number;
  failedCount: number;
  blockedCount: number;
  unsubscribedCount: number;
  createdAt: string;
  updatedAt: string;
  connectionLabel: string | null;
  templateStatus: string | null;
  listLabel: string | null;
  defaultBatchSize: number | null;
};

type TemplateVariableMapping = {
  source?: string;
  key?: string;
};

type CampaignRecipient = {
  id: string;
  contactId: string;
  status: string;
  waMessageId: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  contactPhone: string;
  contactFullName: string | null;
  contactLocation: string | null;
  contactListLabel: string;
  contactMetadata?: Record<string, string> | null;
};

type CampaignRecipientSummary = {
  id: string;
  contactId: string;
  contact_id?: string;
  status: string;
};

type SendMoreContact = {
  id: string;
  contactId: string;
  phone: string;
  fullName: string | null;
  location: string | null;
  listLabel: string;
  metadata: Record<string, string> | null;
};

type CampaignDetailPayload = {
  campaign?: {
    campaign: {
      id: string;
      name: string;
      description: string | null;
      templateName?: string;
      template_name?: string;
      templateLanguage?: string;
      template_language?: string;
      variableMappings?: TemplateVariableMapping[] | null;
      variable_mappings?: TemplateVariableMapping[] | null;
      templateHeader?: string | null;
      template_header?: string | null;
      templateBody?: string | null;
      template_body?: string | null;
      templateFooter?: string | null;
      template_footer?: string | null;
      templateButtons?: unknown[] | null;
      template_buttons?: unknown[] | null;
      status: string;
      scheduledAt?: string | null;
      scheduled_at?: string | null;
      launchedAt?: string | null;
      launched_at?: string | null;
      completedAt?: string | null;
      completed_at?: string | null;
      totalRecipients?: number;
      total_recipients?: number;
      sentCount?: number;
      sent_count?: number;
      deliveredCount?: number;
      delivered_count?: number;
      readCount?: number;
      read_count?: number;
      failedCount?: number;
      failed_count?: number;
      blockedCount?: number;
      blocked_count?: number;
      unsubscribedCount?: number;
      unsubscribed_count?: number;
      createdAt?: string;
      created_at?: string;
      updatedAt?: string;
      updated_at?: string;
      connectionLabel?: string | null;
      connection_label?: string | null;
      templateStatus?: string | null;
      template_status?: string | null;
      listLabel?: string | null;
      list_label?: string | null;
      defaultBatchSize?: number | null;
      default_batch_size?: number | null;
    };
    recipients?: CampaignRecipient[];
  };
};

function normalizeRecipient(recipient: Partial<CampaignRecipient> & Record<string, unknown>): CampaignRecipient {
  return {
    id: String(recipient.id ?? ""),
    contactId: String(recipient.contactId ?? recipient.contact_id ?? ""),
    status: String(recipient.status ?? ""),
    waMessageId: (recipient.waMessageId ?? recipient.wa_message_id ?? null) as string | null,
    sentAt: (recipient.sentAt ?? recipient.sent_at ?? null) as string | null,
    deliveredAt: (recipient.deliveredAt ?? recipient.delivered_at ?? null) as string | null,
    readAt: (recipient.readAt ?? recipient.read_at ?? null) as string | null,
    failedAt: (recipient.failedAt ?? recipient.failed_at ?? null) as string | null,
    errorCode: (recipient.errorCode ?? recipient.error_code ?? null) as string | null,
    errorMessage: (recipient.errorMessage ?? recipient.error_message ?? null) as string | null,
    createdAt: String(recipient.createdAt ?? recipient.created_at ?? ""),
    updatedAt: String(recipient.updatedAt ?? recipient.updated_at ?? ""),
    contactPhone: String(recipient.contactPhone ?? recipient.contact_phone ?? ""),
    contactFullName: (recipient.contactFullName ?? recipient.contact_full_name ?? null) as string | null,
    contactLocation: (recipient.contactLocation ?? recipient.contact_location ?? null) as string | null,
    contactListLabel: String(recipient.contactListLabel ?? recipient.contact_list_label ?? "default"),
    contactMetadata: (recipient.contactMetadata ?? recipient.contact_metadata ?? null) as Record<string, string> | null,
  };
}

function normalizeRecipientSummary(
  recipient: Partial<CampaignRecipientSummary> & Record<string, unknown>,
): CampaignRecipientSummary {
  return {
    id: String(recipient.id ?? ""),
    contactId: String(recipient.contactId ?? recipient.contact_id ?? ""),
    status: String(recipient.status ?? ""),
  };
}

function statusTone(status: string) {
  switch (status) {
    case "SENDING":
      return "border-accent/30 bg-accent/10 text-accent";
    case "SCHEDULED":
      return "border-blue-500/30 bg-blue-500/10 text-blue-300";
    case "PAUSED":
      return "border-primary/30 bg-primary/10 text-primary";
    case "COMPLETED":
      return "border-green-500/30 bg-green-500/10 text-green-300";
    case "FAILED":
      return "border-red-500/30 bg-red-500/10 text-red-300";
    default:
      return "border-border bg-secondary/60 text-foreground";
  }
}

function recipientTone(status: string) {
  switch (status) {
    case "SENT":
      return "border-blue-500/30 bg-blue-500/10 text-blue-300";
    case "DELIVERED":
      return "border-cyan-500/30 bg-cyan-500/10 text-cyan-300";
    case "READ":
      return "border-green-500/30 bg-green-500/10 text-green-300";
    case "FAILED":
    case "BLOCKED":
      return "border-red-500/30 bg-red-500/10 text-red-300";
    case "SKIPPED":
    case "UNSUBSCRIBED":
      return "border-amber-500/30 bg-amber-500/10 text-amber-300";
    default:
      return "border-border bg-secondary/60 text-foreground";
  }
}

function formatDate(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-ZA", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function campaignProgress(campaign: Campaign) {
  if (campaign.totalRecipients <= 0) return 0;
  const processed =
    campaign.sentCount +
    campaign.failedCount +
    campaign.blockedCount +
    campaign.unsubscribedCount;
  return Math.max(0, Math.min(100, Math.round((processed / campaign.totalRecipients) * 100)));
}

function normalizeCampaign(raw: NonNullable<CampaignDetailPayload["campaign"]>["campaign"]): Campaign {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    templateName: raw.templateName ?? raw.template_name ?? "",
    templateLanguage: raw.templateLanguage ?? raw.template_language ?? "",
    variableMappings: raw.variableMappings ?? raw.variable_mappings ?? null,
    templateHeader: raw.templateHeader ?? raw.template_header ?? null,
    templateBody: raw.templateBody ?? raw.template_body ?? null,
    templateFooter: raw.templateFooter ?? raw.template_footer ?? null,
    templateButtons: raw.templateButtons ?? raw.template_buttons ?? null,
    status: raw.status,
    scheduledAt: raw.scheduledAt ?? raw.scheduled_at ?? null,
    launchedAt: raw.launchedAt ?? raw.launched_at ?? null,
    completedAt: raw.completedAt ?? raw.completed_at ?? null,
    totalRecipients: Number(raw.totalRecipients ?? raw.total_recipients ?? 0),
    sentCount: Number(raw.sentCount ?? raw.sent_count ?? 0),
    deliveredCount: Number(raw.deliveredCount ?? raw.delivered_count ?? 0),
    readCount: Number(raw.readCount ?? raw.read_count ?? 0),
    failedCount: Number(raw.failedCount ?? raw.failed_count ?? 0),
    blockedCount: Number(raw.blockedCount ?? raw.blocked_count ?? 0),
    unsubscribedCount: Number(raw.unsubscribedCount ?? raw.unsubscribed_count ?? 0),
    createdAt: raw.createdAt ?? raw.created_at ?? "",
    updatedAt: raw.updatedAt ?? raw.updated_at ?? "",
    connectionLabel: raw.connectionLabel ?? raw.connection_label ?? null,
    templateStatus: raw.templateStatus ?? raw.template_status ?? null,
    listLabel: raw.listLabel ?? raw.list_label ?? null,
    defaultBatchSize: raw.defaultBatchSize ?? raw.default_batch_size ?? null,
  };
}

function metadataValue(metadata: Record<string, string> | null | undefined, key: string) {
  if (!metadata || !key) return "";
  return metadata[key] ?? "";
}

function resolveBodyParameters(recipient: CampaignRecipient, mappings: TemplateVariableMapping[] | null) {
  const values = mappings ?? [];
  return values.map((mapping) => {
    const source = mapping.source ?? "contact";
    const key = mapping.key ?? "";

    if (source === "static") {
      return key;
    }

    switch (key) {
      case "fullName":
      case "name":
        return recipient.contactFullName ?? "";
      case "phone":
        return recipient.contactPhone;
      case "location":
        return recipient.contactLocation ?? "";
      case "tags":
        return metadataValue(recipient.contactMetadata, "tags");
      default:
        return metadataValue(recipient.contactMetadata, key);
    }
  });
}

function renderTemplateBody(templateBody: string | null, bodyParameters: string[]) {
  if (!templateBody) return "";
  return templateBody.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, rawIndex: string) => {
    const index = Number.parseInt(rawIndex, 10) - 1;
    return bodyParameters[index] ?? "";
  });
}

function whatsappLink(phone: string) {
  return `https://wa.me/${phone.replace(/\D/g, "")}`;
}

export default function CampaignDetailPageClient({
  campaign,
  recipients,
}: {
  campaign: Campaign;
  recipients: CampaignRecipient[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [liveCampaign, setLiveCampaign] = useState(campaign);
  const [liveRecipients, setLiveRecipients] = useState(recipients);
  const [notice, setNotice] = useState(searchParams.get("notice") || "");
  const [error, setError] = useState("");
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [isRefreshingLive, setIsRefreshingLive] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState(() => new Date().toISOString());
  const [isPending, startTransition] = useTransition();
  const [launchBatchSize, setLaunchBatchSize] = useState(
    String(campaign.defaultBatchSize || Math.max((recipients.length || campaign.totalRecipients) - campaign.sentCount, 1)),
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sendMoreContacts, setSendMoreContacts] = useState<SendMoreContact[]>([]);
  const [pendingRecipientContactIds, setPendingRecipientContactIds] = useState<string[]>([]);
  const [sendMoreSearch, setSendMoreSearch] = useState("");
  const [sendMoreBatchSize, setSendMoreBatchSize] = useState("0");
  const [excludedContactIds, setExcludedContactIds] = useState<string[]>([]);
  const [loadingSendMore, setLoadingSendMore] = useState(false);
  const [sendMoreOpen, setSendMoreOpen] = useState(false);
  const [previewRecipient, setPreviewRecipient] = useState<CampaignRecipient | null>(null);

  useEffect(() => {
    setLiveCampaign(campaign);
    setLiveRecipients(recipients.map((recipient) => normalizeRecipient(recipient)));
    setLastSyncedAt(new Date().toISOString());
  }, [campaign, recipients]);

  const effectiveTotalRecipients = useMemo(() => {
    return liveRecipients.length > 0 ? liveRecipients.length : liveCampaign.totalRecipients;
  }, [liveCampaign.totalRecipients, liveRecipients.length]);

  const effectiveCampaign = useMemo(
    () => ({ ...liveCampaign, totalRecipients: effectiveTotalRecipients }),
    [effectiveTotalRecipients, liveCampaign],
  );

  const refreshCampaign = useEffectEvent(async () => {
    try {
      setIsRefreshingLive(true);
      const response = await fetch(apiUrl(`/api/whatsapp/campaigns/${liveCampaign.id}`), {
        credentials: "include",
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => ({}))) as CampaignDetailPayload;
      if (!response.ok || !payload.campaign?.campaign) return;
      setLiveCampaign(normalizeCampaign(payload.campaign.campaign));
      setLiveRecipients((payload.campaign.recipients ?? []).map((recipient) => normalizeRecipient(recipient)));
      setLastSyncedAt(new Date().toISOString());
    } catch {
      // Ignore transient refresh failures.
    } finally {
      setIsRefreshingLive(false);
    }
  });

  useEffect(() => {
    const shouldPoll =
      liveCampaign.status === "SENDING" ||
      liveCampaign.status === "SCHEDULED" ||
      liveCampaign.status === "PAUSED";
    if (!shouldPoll) return;

    const intervalId = window.setInterval(() => {
      void refreshCampaign();
    }, 4000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [liveCampaign.id, liveCampaign.status]);

  useEffect(() => {
    const source = new EventSource(apiUrl("/api/realtime/whatsapp"), {
      withCredentials: true,
    });

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as WhatsappRealtimeEvent;
        if (payload.type === "campaign.updated" && payload.campaignId === liveCampaign.id) {
          void refreshCampaign();
        }
      } catch {
        // Ignore malformed realtime payloads.
      }
    };

    return () => {
      source.close();
    };
  }, [liveCampaign.id]);

  const remaining = useMemo(() => {
    const processed =
      effectiveCampaign.sentCount +
      effectiveCampaign.failedCount +
      effectiveCampaign.blockedCount +
      effectiveCampaign.unsubscribedCount;
    return Math.max(effectiveCampaign.totalRecipients - processed, 0);
  }, [effectiveCampaign]);

  const currentLaunchBatchSize = Math.min(
    Math.max(Number.parseInt(launchBatchSize || "0", 10) || 0, 0),
    remaining || effectiveCampaign.totalRecipients,
  );

  const recipientCounts = useMemo(() => {
    return liveRecipients.reduce<Record<string, number>>((acc, recipient) => {
      acc[recipient.status] = (acc[recipient.status] || 0) + 1;
      return acc;
    }, {});
  }, [liveRecipients]);

  const queuedCount = recipientCounts.QUEUED || 0;
  const pendingCount = recipientCounts.PENDING || 0;
  const processedCount = Math.max(effectiveCampaign.totalRecipients - queuedCount - pendingCount, 0);
  const activeSendPosition = Math.min(processedCount + queuedCount, effectiveCampaign.totalRecipients);
  const isLiveSending = effectiveCampaign.status === "SENDING";
  const hasProcessedRecipients = processedCount > 0;
  const sendMoreAvailableContacts = useMemo(() => {
    const base = sendMoreContacts.filter((contact) => pendingRecipientContactIds.includes(contact.contactId));
    const needle = sendMoreSearch.trim().toLowerCase();
    if (!needle) return base;
    return base.filter((contact) =>
      [contact.fullName || "", contact.phone, contact.location || "", Object.values(contact.metadata || {}).join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [pendingRecipientContactIds, sendMoreContacts, sendMoreSearch]);
  const excludedSendMoreContacts = useMemo(() => {
    return sendMoreContacts.filter(
      (contact) => pendingRecipientContactIds.includes(contact.contactId) && excludedContactIds.includes(contact.contactId),
    );
  }, [excludedContactIds, pendingRecipientContactIds, sendMoreContacts]);
  const selectableSendMoreCount = Math.max(sendMoreAvailableContacts.length - excludedContactIds.length, 0);
  const currentSendMoreBatchSize = Math.min(
    Math.max(Number.parseInt(sendMoreBatchSize || "0", 10) || 0, 0),
    selectableSendMoreCount,
  );
  const previewBodyParameters = useMemo(
    () => (previewRecipient ? resolveBodyParameters(previewRecipient, liveCampaign.variableMappings) : []),
    [liveCampaign.variableMappings, previewRecipient],
  );
  const previewBodyText = useMemo(
    () => renderTemplateBody(liveCampaign.templateBody, previewBodyParameters),
    [liveCampaign.templateBody, previewBodyParameters],
  );

  async function runAction(kind: "launch" | "pause" | "resume" | "cancel" | "retry_failed" | "repair_status") {
    setLoadingAction(kind);
    setError("");
    setNotice("");

    try {
      const endpoint =
        kind === "launch"
          ? apiUrl(`/api/whatsapp/campaigns/${liveCampaign.id}/launch`)
          : apiUrl(`/api/whatsapp/campaigns/${liveCampaign.id}`);
      const response = await fetch(endpoint, {
        method: kind === "launch" ? "POST" : "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body:
          kind === "launch"
            ? JSON.stringify({ batchSize: currentLaunchBatchSize })
            : JSON.stringify({ action: kind }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || `Failed to ${kind.replace("_", " ")} campaign`);
      }

      const nextNotice =
        kind === "launch"
          ? `Queued ${body.queuedRecipients || currentLaunchBatchSize} recipients for sending.`
          : kind === "pause"
            ? "Campaign paused."
            : kind === "resume"
              ? "Campaign resumed."
              : kind === "cancel"
                ? "Campaign cancelled."
                : kind === "retry_failed"
                  ? "Failed recipients queued again."
                  : "Campaign status repaired.";

      setNotice(nextNotice);
      startTransition(() => {
        router.refresh();
      });
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Campaign action failed");
    } finally {
      setLoadingAction(null);
    }
  }

  async function openSendMoreModal() {
    if (!liveCampaign.listLabel) {
      setError("This campaign has no locked contact list.");
      return;
    }

    setLoadingSendMore(true);
    setError("");
    setNotice("");

    try {
      const [campaignDetail, contactsPayload] = await Promise.all([
        fetch(apiUrl(`/api/whatsapp/campaigns/${liveCampaign.id}`), {
          credentials: "include",
          cache: "no-store",
        }).then(async (response) => {
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error || "Failed to load campaign details");
          return body as { campaign: { recipients: Array<CampaignRecipientSummary & Record<string, unknown>> } };
        }),
        fetch(apiUrl(`/api/whatsapp/contacts?listLabel=${encodeURIComponent(liveCampaign.listLabel)}&limit=10000`), {
          credentials: "include",
          cache: "no-store",
        }).then(async (response) => {
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error || "Failed to load contacts");
          return body as { contacts: SendMoreContact[] };
        }),
      ]);

      const recipientIds = campaignDetail.campaign.recipients
        .map((recipient) => normalizeRecipientSummary(recipient))
        .filter((recipient) => recipient.status === "PENDING")
        .map((recipient) => recipient.contactId)
        .filter(Boolean);
      const availableCount = contactsPayload.contacts.filter((contact) => recipientIds.includes(contact.contactId)).length;

      setSendMoreContacts(contactsPayload.contacts);
      setPendingRecipientContactIds(recipientIds);
      setExcludedContactIds([]);
      setSendMoreSearch("");
      setSendMoreBatchSize(String(Math.min(liveCampaign.defaultBatchSize || 200, availableCount)));
      setSendMoreOpen(true);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Failed to load send more details");
    } finally {
      setLoadingSendMore(false);
    }
  }

  async function confirmSendMore() {
    if (currentSendMoreBatchSize <= 0) {
      setError("Select at least one contact for the next batch.");
      return;
    }

    setLoadingAction("send_more");
    setError("");
    setNotice("");

    try {
      const response = await fetch(apiUrl(`/api/whatsapp/campaigns/${liveCampaign.id}`), {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "send_more",
          batchSize: currentSendMoreBatchSize,
          excludedContactIds,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || "Failed to send next batch");
      }
      setNotice(`Queued ${body.queuedRecipients || currentSendMoreBatchSize} more recipients.`);
      setSendMoreOpen(false);
      startTransition(() => {
        router.refresh();
      });
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Send more failed");
    } finally {
      setLoadingAction(null);
    }
  }

  async function deleteCampaign() {
    setLoadingAction("delete");
    setError("");
    setNotice("");
    try {
      const response = await fetch(apiUrl(`/api/whatsapp/campaigns/${liveCampaign.id}`), {
        method: "DELETE",
        credentials: "include",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || "Failed to delete campaign");
      }
      router.push("/reach/campaigns");
      router.refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Failed to delete campaign");
    } finally {
      setLoadingAction(null);
      setConfirmDelete(false);
    }
  }

  const launchable =
    (liveCampaign.status === "DRAFT" && pendingCount > 0) ||
    ((liveCampaign.status === "COMPLETED" || liveCampaign.status === "FAILED") &&
      pendingCount > 0 &&
      queuedCount === 0 &&
      !hasProcessedRecipients);
  const pausable = liveCampaign.status === "SENDING" || liveCampaign.status === "SCHEDULED";
  const resumable = liveCampaign.status === "PAUSED";
  const idleSendingWithPending = liveCampaign.status === "SENDING" && queuedCount === 0 && pendingCount > 0;
  const sendMoreable =
    (liveCampaign.status === "COMPLETED" &&
      remaining > 0 &&
      hasProcessedRecipients) ||
    idleSendingWithPending ||
    liveCampaign.status === "FAILED" ||
    liveCampaign.status === "PAUSED";
  const deletable =
    liveCampaign.status === "DRAFT" ||
    liveCampaign.status === "PAUSED" ||
    liveCampaign.status === "COMPLETED" ||
    liveCampaign.status === "FAILED";
  const cancellable =
    liveCampaign.status === "DRAFT" ||
    liveCampaign.status === "PAUSED" ||
    liveCampaign.status === "SENDING" ||
    liveCampaign.status === "SCHEDULED" ||
    liveCampaign.status === "FAILED";

  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <Link href="/reach/campaigns" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
              Back to campaigns
            </Link>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">{liveCampaign.name}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Template: {liveCampaign.templateName} · {liveCampaign.templateLanguage} · {liveCampaign.connectionLabel || "No connection"}
            </p>
            {liveCampaign.description ? (
              <p className="mt-3 max-w-3xl text-sm text-muted-foreground">{liveCampaign.description}</p>
            ) : null}
          </div>
          <Badge className={statusTone(liveCampaign.status)}>{liveCampaign.status}</Badge>
        </div>

        {(error || notice) && (
          <div
            className={`rounded-xl border px-4 py-3 text-sm ${
              error
                ? "border-red-500/30 bg-red-500/10 text-red-300"
                : "border-green-500/30 bg-green-500/10 text-green-300"
            }`}
          >
            {error || notice}
          </div>
        )}

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
          <MetricCard label="Recipients" value={effectiveCampaign.totalRecipients} />
          <MetricCard label="Sent" value={effectiveCampaign.sentCount} />
          <MetricCard label="Delivered" value={effectiveCampaign.deliveredCount} />
          <MetricCard label="Read" value={effectiveCampaign.readCount} />
          <MetricCard label="Failed" value={effectiveCampaign.failedCount + effectiveCampaign.blockedCount} />
          <MetricCard label="Remaining" value={remaining} />
        </section>

        <Card>
          <CardContent className="space-y-5 p-5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Live sending status</h2>
                <p className="text-sm text-muted-foreground">
                  Refreshes every 4 seconds while the campaign is active.
                </p>
              </div>
              <div className="text-sm text-muted-foreground">
                {isRefreshingLive ? "Refreshing now..." : `Last synced ${formatDate(lastSyncedAt)}`}
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
              <MetricCard label="Processed" value={processedCount} />
              <MetricCard label="Queued now" value={queuedCount} />
              <MetricCard label="Still pending" value={pendingCount} />
              <MetricCard label="Current position" value={activeSendPosition} />
              <MetricCard label="Batch accepted" value={effectiveCampaign.sentCount} />
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="rounded-xl border border-border bg-secondary/20 p-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Campaign completion</span>
                  <span className="font-medium text-foreground">
                    {processedCount.toLocaleString("en-ZA")} / {effectiveCampaign.totalRecipients.toLocaleString("en-ZA")}
                  </span>
                </div>
                <div className="mt-3">
                  <Progress
                    value={
                      effectiveCampaign.totalRecipients > 0
                        ? (processedCount / effectiveCampaign.totalRecipients) * 100
                        : 0
                    }
                  />
                </div>
                <p className="mt-3 text-sm text-muted-foreground">
                  {isLiveSending
                    ? `The backend worker is actively sending. ${queuedCount.toLocaleString("en-ZA")} recipients are queued in the current run.`
                    : liveCampaign.status === "SCHEDULED"
                      ? "The campaign is queued to start later."
                      : liveCampaign.status === "PAUSED"
                        ? "The campaign is paused. Pending recipients are waiting for resume."
                        : "The campaign is not actively sending right now."}
                </p>
              </div>

              <div className="rounded-xl border border-border bg-secondary/20 p-4">
                <div className="text-sm font-semibold text-foreground">Recipient state breakdown</div>
                <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                  <MiniStat label="Pending" value={pendingCount} />
                  <MiniStat label="Queued" value={queuedCount} />
                  <MiniStat label="Sent" value={effectiveCampaign.sentCount} />
                  <MiniStat label="Delivered" value={effectiveCampaign.deliveredCount} />
                  <MiniStat label="Read" value={effectiveCampaign.readCount} />
                  <MiniStat label="Failed" value={effectiveCampaign.failedCount + effectiveCampaign.blockedCount} />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-5 p-5">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Progress</span>
                <span className="font-medium text-foreground">{campaignProgress(effectiveCampaign)}%</span>
              </div>
              <Progress value={campaignProgress(effectiveCampaign)} />
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <InfoCard label="List label" value={liveCampaign.listLabel || "default"} />
                <InfoCard label="Scheduled" value={formatDate(liveCampaign.scheduledAt)} />
                <InfoCard label="Launched" value={formatDate(liveCampaign.launchedAt)} />
                <InfoCard label="Completed" value={formatDate(liveCampaign.completedAt)} />
              </div>

              <div className="rounded-xl border border-border bg-secondary/20 p-4">
                <div className="text-sm font-semibold text-foreground">Actions</div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {launchable ? (
                    <>
                      <Input
                        type="number"
                        min={1}
                        max={remaining || 1}
                        value={launchBatchSize}
                        onChange={(event) => setLaunchBatchSize(event.target.value)}
                        className="w-32"
                      />
                      <Button
                        disabled={isPending || loadingAction === "launch" || currentLaunchBatchSize <= 0}
                        onClick={() => void runAction("launch")}
                      >
                        {loadingAction === "launch" ? "Queueing..." : "Launch batch"}
                      </Button>
                    </>
                  ) : null}
                  {pausable ? (
                    <Button
                      variant="secondary"
                      disabled={isPending || loadingAction === "pause"}
                      onClick={() => void runAction("pause")}
                    >
                      Pause
                    </Button>
                  ) : null}
                  {resumable ? (
                    <Button
                      variant="secondary"
                      disabled={isPending || loadingAction === "resume"}
                      onClick={() => void runAction("resume")}
                    >
                      Resume
                    </Button>
                  ) : null}
                  {sendMoreable ? (
                    <Button
                      variant="secondary"
                      disabled={isPending || loadingAction === "send_more" || loadingSendMore}
                      onClick={() => void openSendMoreModal()}
                    >
                      Send More
                    </Button>
                  ) : null}
                  {cancellable ? (
                    <Button
                      variant="outline"
                      disabled={isPending || loadingAction === "cancel"}
                      onClick={() => void runAction("cancel")}
                    >
                      Cancel
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    disabled={isPending || loadingAction === "repair_status"}
                    onClick={() => void runAction("repair_status")}
                  >
                    Repair status
                  </Button>
                  {deletable ? (
                    confirmDelete ? (
                      <>
                        <Button
                          variant="destructive"
                          disabled={loadingAction === "delete"}
                          onClick={() => void deleteCampaign()}
                        >
                          Confirm Delete
                        </Button>
                        <Button variant="outline" onClick={() => setConfirmDelete(false)}>
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <Button variant="outline" onClick={() => setConfirmDelete(true)}>
                        Delete
                      </Button>
                    )
                  ) : null}
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  Use repair status if replies or webhook updates landed but the counts on this campaign look wrong.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-0">
            <div className="border-b border-border px-5 py-4">
              <h2 className="text-lg font-semibold text-foreground">Recipients</h2>
              <p className="text-sm text-muted-foreground">
                Per-recipient delivery state for this campaign.
              </p>
            </div>
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-secondary/40 text-left text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">#</th>
                    <th className="px-4 py-3">Contact</th>
                    <th className="px-4 py-3">Phone</th>
                    <th className="px-4 py-3">Location</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Sent</th>
                    <th className="px-4 py-3">Delivered</th>
                    <th className="px-4 py-3">Read</th>
                    <th className="px-4 py-3">Error</th>
                    <th className="px-4 py-3">Message</th>
                    <th className="px-4 py-3">Metadata</th>
                  </tr>
                </thead>
                <tbody>
                  {liveRecipients.map((recipient, index) => (
                    <tr key={recipient.id} className="border-t border-border align-top">
                      <td className="px-4 py-3 text-xs text-muted-foreground">{index + 1}</td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-foreground">
                          {recipient.contactFullName || recipient.contactPhone}
                        </div>
                        <div className="text-xs text-muted-foreground">{recipient.contactListLabel}</div>
                      </td>
                      <td className="px-4 py-3">
                        <a
                          href={whatsappLink(recipient.contactPhone)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-foreground underline-offset-4 hover:text-primary hover:underline"
                        >
                          {recipient.contactPhone}
                        </a>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{recipient.contactLocation || "-"}</td>
                      <td className="px-4 py-3">
                        <Badge className={recipientTone(recipient.status)}>{recipient.status}</Badge>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                        {formatDate(recipient.sentAt)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                        {formatDate(recipient.deliveredAt)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                        {formatDate(recipient.readAt)}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {recipient.errorMessage || recipient.errorCode || "-"}
                      </td>
                      <td className="px-4 py-3">
                        <Button variant="outline" size="sm" onClick={() => setPreviewRecipient(recipient)}>
                          View message
                        </Button>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {recipient.contactMetadata && Object.keys(recipient.contactMetadata).length > 0
                          ? Object.entries(recipient.contactMetadata)
                              .slice(0, 4)
                              .map(([key, value]) => `${key}: ${value}`)
                              .join(" · ")
                          : "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
        {previewRecipient ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-8">
            <div className="max-h-[90vh] w-full max-w-4xl overflow-auto rounded-2xl border border-border bg-background shadow-2xl">
              <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
                <div>
                  <h2 className="text-2xl font-semibold text-foreground">Template preview</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {previewRecipient.contactFullName || previewRecipient.contactPhone} · {liveCampaign.templateName} ·{" "}
                    {liveCampaign.templateLanguage}
                  </p>
                </div>
                <Button variant="outline" onClick={() => setPreviewRecipient(null)}>
                  Close
                </Button>
              </div>

              <div className="space-y-6 px-6 py-5">
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
                  <div className="rounded-xl border border-border bg-secondary/20 p-5">
                    <div className="text-sm font-semibold text-foreground">Rendered message</div>
                    {liveCampaign.templateHeader ? (
                      <div className="mt-4 rounded-lg border border-border bg-background px-4 py-3 text-sm text-muted-foreground">
                        <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Header</div>
                        <div className="whitespace-pre-wrap text-foreground">{liveCampaign.templateHeader}</div>
                      </div>
                    ) : null}
                    <div className="mt-4 rounded-lg border border-border bg-background px-4 py-4">
                      <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Body</div>
                      <div className="whitespace-pre-wrap text-sm leading-6 text-foreground">
                        {previewBodyText || liveCampaign.templateBody || "No template body available."}
                      </div>
                    </div>
                    {liveCampaign.templateFooter ? (
                      <div className="mt-4 rounded-lg border border-border bg-background px-4 py-3 text-sm text-muted-foreground">
                        <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Footer</div>
                        <div className="whitespace-pre-wrap text-foreground">{liveCampaign.templateFooter}</div>
                      </div>
                    ) : null}
                  </div>

                  <div className="space-y-4">
                    <div className="rounded-xl border border-border bg-secondary/20 p-4">
                      <div className="text-sm font-semibold text-foreground">Resolved parameters</div>
                      <div className="mt-4 space-y-3">
                        {previewBodyParameters.length > 0 ? (
                          previewBodyParameters.map((value, index) => {
                            const mapping = liveCampaign.variableMappings?.[index];
                            const mappingLabel =
                              mapping?.source === "static"
                                ? `Static text`
                                : mapping?.key || `Variable ${index + 1}`;
                            return (
                              <div key={`${mappingLabel}-${index}`} className="rounded-lg border border-border bg-background px-3 py-3">
                                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                                  {`{{${index + 1}}}`} · {mappingLabel}
                                </div>
                                <div className="mt-1 whitespace-pre-wrap text-sm text-foreground">
                                  {value || <span className="text-red-300">Empty value</span>}
                                </div>
                              </div>
                            );
                          })
                        ) : (
                          <div className="rounded-lg border border-border bg-background px-3 py-3 text-sm text-muted-foreground">
                            This template does not use mapped body variables.
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="rounded-xl border border-border bg-secondary/20 p-4">
                      <div className="text-sm font-semibold text-foreground">Recipient context</div>
                      <div className="mt-3 space-y-2 text-sm text-muted-foreground">
                        <div>Phone: <span className="text-foreground">{previewRecipient.contactPhone}</span></div>
                        <div>Name: <span className="text-foreground">{previewRecipient.contactFullName || "-"}</span></div>
                        <div>Location: <span className="text-foreground">{previewRecipient.contactLocation || "-"}</span></div>
                        <div>Status: <span className="text-foreground">{previewRecipient.status}</span></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}
        {sendMoreOpen ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-8">
            <div className="max-h-[90vh] w-full max-w-5xl overflow-auto rounded-2xl border border-border bg-background p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-semibold text-foreground">Send more: {liveCampaign.name}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Locked list: {liveCampaign.listLabel || "default"} · Already sent: {effectiveCampaign.sentCount} · Delivered:{" "}
                    {effectiveCampaign.deliveredCount} · Read: {effectiveCampaign.readCount}
                  </p>
                </div>
                <Button variant="outline" onClick={() => setSendMoreOpen(false)}>
                  Close
                </Button>
              </div>

              <div className="mt-5 grid gap-4 md:grid-cols-4">
                <div className="rounded-lg bg-secondary/40 p-4">
                  <div className="text-xs text-muted-foreground">Original recipients</div>
                  <div className="mt-1 text-xl font-semibold">{effectiveCampaign.totalRecipients}</div>
                </div>
                <div className="rounded-lg bg-secondary/40 p-4">
                  <div className="text-xs text-muted-foreground">Pending in campaign</div>
                  <div className="mt-1 text-xl font-semibold">{pendingRecipientContactIds.length}</div>
                </div>
                <div className="rounded-lg bg-secondary/40 p-4">
                  <div className="text-xs text-muted-foreground">Remaining available</div>
                  <div className="mt-1 text-xl font-semibold">{sendMoreAvailableContacts.length}</div>
                </div>
                <div className="rounded-lg bg-secondary/40 p-4">
                  <div className="text-xs text-muted-foreground">This next batch</div>
                  <div className="mt-1 text-xl font-semibold">{currentSendMoreBatchSize}</div>
                </div>
              </div>

              <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
                <div className="space-y-3">
                  <div className="grid gap-3 md:grid-cols-[1fr_180px]">
                    <Input
                      placeholder="Search remaining contacts..."
                      value={sendMoreSearch}
                      onChange={(event) => setSendMoreSearch(event.target.value)}
                    />
                    <Input
                      type="number"
                      min={1}
                      max={selectableSendMoreCount || 1}
                      value={sendMoreBatchSize}
                      onChange={(event) => setSendMoreBatchSize(event.target.value)}
                    />
                  </div>

                  <div className="max-h-[420px] space-y-2 overflow-y-auto rounded-xl border border-border p-3">
                    {sendMoreAvailableContacts.map((contact) => {
                      const excluded = excludedContactIds.includes(contact.id);
                      return (
                        <div
                          key={contact.id}
                          className="flex items-center justify-between gap-3 rounded-lg border border-border bg-secondary/30 px-3 py-3"
                        >
                          <div className="min-w-0">
                            <div className="font-medium text-foreground">{contact.fullName || contact.phone}</div>
                            <div className="truncate text-sm text-muted-foreground">
                              {contact.phone}
                              {contact.location ? ` · ${contact.location}` : ""}
                            </div>
                          </div>
                          <Button
                            type="button"
                            variant={excluded ? "destructive" : "outline"}
                            size="sm"
                            onClick={() =>
                              setExcludedContactIds((current) =>
                                current.includes(contact.contactId)
                                  ? current.filter((value) => value !== contact.contactId)
                                  : [...current, contact.contactId],
                              )
                            }
                          >
                            {excluded ? "Excluded" : "Exclude"}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="rounded-xl border border-border p-4">
                  <h3 className="text-sm font-semibold text-foreground">Excluded from this batch</h3>
                  <div className="mt-3 space-y-2">
                    {excludedContactIds.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No contacts excluded.</p>
                    ) : (
                      excludedSendMoreContacts.map((contact) => (
                          <div
                            key={contact.id}
                            className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
                          >
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium text-foreground">
                                {contact.fullName || contact.phone}
                              </div>
                              <div className="truncate text-xs text-muted-foreground">{contact.phone}</div>
                            </div>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                setExcludedContactIds((current) => current.filter((value) => value !== contact.id))
                              }
                            >
                              Remove
                            </Button>
                          </div>
                        ))
                    )}
                  </div>
                </div>
              </div>

              <div className="mt-6 flex justify-end gap-3">
                <Button variant="outline" onClick={() => setSendMoreOpen(false)}>
                  Cancel
                </Button>
                <Button
                  disabled={loadingAction === "send_more" || loadingSendMore || currentSendMoreBatchSize <= 0}
                  onClick={() => void confirmSendMore()}
                >
                  {loadingAction === "send_more" ? "Queueing..." : "Send next batch"}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: number | null | undefined }) {
  const displayValue = Number(value ?? 0);

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-foreground">
        {displayValue.toLocaleString("en-ZA")}
      </div>
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-secondary/20 p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-2 font-medium text-foreground">{value}</div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-background/40 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-semibold text-foreground">{value.toLocaleString("en-ZA")}</div>
    </div>
  );
}
