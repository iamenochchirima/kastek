import { AskGrowthAgent } from "@/components/dashboard/agents/agent-context";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { ArrowLeft, ChevronDown, Search, RotateCcw, MoreHorizontal, Send, Users, Phone, X } from "@/components/ui/interface-icons";
import "./campaign-detail.css";
import { Progress } from "@/components/ui/progress";
import { apiUrl } from "@/lib/server-api";
import type { WhatsappRealtimeEvent } from "@/lib/whatsapp/types";
import { useWhatsappRealtimeSubscription } from "@/components/dashboard/whatsapp-realtime-provider";
import { Link } from "react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { MotionReveal } from "@/components/ui/motion-reveal";
import { toast } from "sonner";
import { scheduledInstants, timeZoneOptions } from "./campaign-create-utils";

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

type CampaignSummaryPayload = {
  campaign?: NonNullable<CampaignDetailPayload["campaign"]>["campaign"];
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

function statusTone(status: string) {
  switch (status) {
    case "SENDING":
      return "border-status-info/30 bg-status-info-soft text-status-info";
    case "SCHEDULED":
      return "border-status-info/30 bg-status-info-soft text-status-info";
    case "PAUSED":
      return "border-primary/30 bg-primary/10 text-primary";
    case "COMPLETED":
      return "border-status-success/30 bg-status-success-soft text-status-success";
    case "FAILED":
      return "border-destructive/30 bg-status-danger-soft text-destructive";
    default:
      return "border-border bg-secondary/60 text-foreground";
  }
}

function recipientTone(status: string) {
  switch (status) {
    case "PROCESSING":
      return "border-primary/30 bg-primary/10 text-primary";
    case "SENT":
      return "border-status-info/30 bg-status-info-soft text-status-info";
    case "DELIVERED":
      return "border-status-info/30 bg-status-info-soft text-status-info";
    case "READ":
      return "border-status-success/30 bg-status-success-soft text-status-success";
    case "FAILED":
    case "BLOCKED":
      return "border-destructive/30 bg-status-danger-soft text-destructive";
    case "SKIPPED":
    case "UNSUBSCRIBED":
      return "border-status-attention/30 bg-status-attention-soft text-status-attention";
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

function localDateInput(value: string | null, timeZone: string) {
  if (!value || Number.isNaN(Date.parse(value))) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
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

function mergeCampaignRealtimeSummary(
  current: Campaign,
  realtime: Extract<WhatsappRealtimeEvent, { type: "campaign.updated" }>["campaign"],
): Campaign {
  return {
    ...current,
    status: realtime.status,
    totalRecipients: Number(realtime.totalRecipients ?? current.totalRecipients),
    sentCount: Number(realtime.sentCount ?? current.sentCount),
    deliveredCount: Number(realtime.deliveredCount ?? current.deliveredCount),
    readCount: Number(realtime.readCount ?? current.readCount),
    failedCount: Number(realtime.failedCount ?? current.failedCount),
    blockedCount: Number(realtime.blockedCount ?? current.blockedCount),
    unsubscribedCount: Number(realtime.unsubscribedCount ?? current.unsubscribedCount),
    updatedAt: realtime.updatedAt ?? current.updatedAt,
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

function recipientErrorText(recipient: CampaignRecipient) {
  return recipient.errorMessage || recipient.errorCode || "";
}

export default function CampaignDetailPageClient({
  campaign,
  recipients,
}: {
  campaign: Campaign;
  recipients: CampaignRecipient[];
}) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [liveCampaign, setLiveCampaign] = useState(campaign);
  const [liveRecipients, setLiveRecipients] = useState(recipients);
  const [notice, setNotice] = useState(searchParams.get("notice") || "");
  const [error, setError] = useState("");
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [isRefreshingLive, setIsRefreshingLive] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState(() => new Date().toISOString());
  const [launchBatchSize, setLaunchBatchSize] = useState(
    String(campaign.defaultBatchSize || Math.max((recipients.length || campaign.totalRecipients) - campaign.sentCount, 1)),
  );
  const [recipientSearch, setRecipientSearch] = useState("");
  const [recipientFilter, setRecipientFilter] = useState("ALL");
  const [recipientTab, setRecipientTab] = useState("all");
  const [selectedRecipientId, setSelectedRecipientId] = useState<string | null>(null);
  const [wideInspector, setWideInspector] = useState(() => typeof window !== "undefined" && window.matchMedia("(min-width: 1200px)").matches);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"launch" | "retry_failed" | "cancel" | null>(null);
  const [refreshError, setRefreshError] = useState("");
  const [launchTiming, setLaunchTiming] = useState<"now" | "later">(campaign.scheduledAt ? "later" : "now");
  const [launchTimeZone, setLaunchTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [launchDate, setLaunchDate] = useState(() => localDateInput(campaign.scheduledAt, Intl.DateTimeFormat().resolvedOptions().timeZone));
  const [launchOccurrence, setLaunchOccurrence] = useState("");
  const launchInstants = useMemo(() => scheduledInstants(launchDate, launchTimeZone), [launchDate, launchTimeZone]);
  const selectedLaunchInstant = launchInstants.length === 1 ? launchInstants[0] : launchInstants.includes(launchOccurrence) ? launchOccurrence : "";
  const launchScheduleValid = launchTiming === "now" || Boolean(selectedLaunchInstant && Date.parse(selectedLaunchInstant) > Date.now());
  const mutationRef = useRef(false);
  const activeCampaignIdRef = useRef(campaign.id);
  const configuredCampaignIdRef = useRef(campaign.id);
  const refreshControllersRef = useRef(new Map<string, AbortController>());
  const sendMoreControllerRef = useRef<AbortController | null>(null);
  const menuActionRef = useRef<(() => void) | null>(null);
  const menuActionFrameRef = useRef<number | null>(null);
  const [sendMoreContacts, setSendMoreContacts] = useState<SendMoreContact[]>([]);
  const [pendingRecipientContactIds, setPendingRecipientContactIds] = useState<string[]>([]);
  const [sendMoreSearch, setSendMoreSearch] = useState("");
  const [sendMoreBatchSize, setSendMoreBatchSize] = useState("0");
  const [excludedContactIds, setExcludedContactIds] = useState<string[]>([]);
  const [loadingSendMore, setLoadingSendMore] = useState(false);
  const [sendMoreOpen, setSendMoreOpen] = useState(false);
  const [previewRecipient, setPreviewRecipient] = useState<CampaignRecipient | null>(null);
  const [errorPreviewRecipient, setErrorPreviewRecipient] = useState<CampaignRecipient | null>(null);
  const detailRefreshTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1200px)");
    const update = () => setWideInspector(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (configuredCampaignIdRef.current !== campaign.id) {
      configuredCampaignIdRef.current = campaign.id;
      setLaunchTiming(campaign.scheduledAt ? "later" : "now");
      setLaunchDate(localDateInput(campaign.scheduledAt, Intl.DateTimeFormat().resolvedOptions().timeZone));
      setLaunchTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
      setLaunchOccurrence("");
      setLaunchBatchSize(String(campaign.defaultBatchSize || Math.max(campaign.totalRecipients - campaign.sentCount, 1)));
      setConfirmAction(null);
      setConfirmDelete(false);
      setSendMoreOpen(false);
      setLoadingSendMore(false);
      setPreviewRecipient(null);
      setErrorPreviewRecipient(null);
      setSelectedRecipientId(null);
      setRecipientSearch("");
      setRecipientFilter("ALL");
      setRecipientTab("all");
      setError("");
      setNotice("");
    }
    setLiveCampaign(campaign);
    setLiveRecipients(recipients.map((recipient) => normalizeRecipient(recipient)));
    setLastSyncedAt(new Date().toISOString());
    setRefreshError("");
  }, [campaign, recipients]);

  useEffect(() => {
    activeCampaignIdRef.current = campaign.id;
    setIsRefreshingLive(false);
    const controllers = refreshControllersRef.current;
    return () => {
      activeCampaignIdRef.current = "";
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
      sendMoreControllerRef.current?.abort();
      sendMoreControllerRef.current = null;
      menuActionRef.current = null;
      if (menuActionFrameRef.current !== null) window.cancelAnimationFrame(menuActionFrameRef.current);
      if (detailRefreshTimeoutRef.current !== null) window.clearTimeout(detailRefreshTimeoutRef.current);
    };
  }, [campaign.id]);

  const effectiveTotalRecipients = useMemo(() => {
    return liveRecipients.length > 0 ? liveRecipients.length : liveCampaign.totalRecipients;
  }, [liveCampaign.totalRecipients, liveRecipients.length]);

  const effectiveCampaign = useMemo(
    () => ({ ...liveCampaign, totalRecipients: effectiveTotalRecipients }),
    [effectiveTotalRecipients, liveCampaign],
  );

  const refreshCampaign = useCallback(async (campaignId: string, summary = false) => {
    const requestKey = "campaign";
    if (activeCampaignIdRef.current !== campaignId || refreshControllersRef.current.has(requestKey)) return;
    const controller = new AbortController();
    refreshControllersRef.current.set(requestKey, controller);
    setIsRefreshingLive(true);
    try {
      const response = await fetch(apiUrl(`/api/whatsapp/campaigns/${campaignId}${summary ? "/summary" : ""}`), {
        credentials: "include", cache: "no-store", signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({})) as CampaignDetailPayload | CampaignSummaryPayload;
      if (!response.ok || !payload.campaign) throw new Error("Campaign updates are unavailable. Displayed results may be out of date.");
      if (controller.signal.aborted || activeCampaignIdRef.current !== campaignId) return;
      if (summary) {
        const next = normalizeCampaign((payload as CampaignSummaryPayload).campaign!);
        setLiveCampaign((current) => ({ ...current, status: next.status, totalRecipients: next.totalRecipients,
          sentCount: next.sentCount, deliveredCount: next.deliveredCount, readCount: next.readCount,
          failedCount: next.failedCount, blockedCount: next.blockedCount, unsubscribedCount: next.unsubscribedCount,
          scheduledAt: next.scheduledAt, launchedAt: next.launchedAt, completedAt: next.completedAt, updatedAt: next.updatedAt }));
        if (!["SENDING", "SCHEDULED", "PAUSED"].includes(next.status)) {
          const detailResponse = await fetch(apiUrl(`/api/whatsapp/campaigns/${campaignId}`), {
            credentials: "include", cache: "no-store", signal: controller.signal,
          });
          const detailPayload = await detailResponse.json().catch(() => ({})) as CampaignDetailPayload;
          if (!detailResponse.ok || !detailPayload.campaign?.campaign) throw new Error("Final recipient results could not be refreshed. Displayed results may be out of date.");
          if (controller.signal.aborted || activeCampaignIdRef.current !== campaignId) return;
          setLiveCampaign(normalizeCampaign(detailPayload.campaign.campaign));
          setLiveRecipients((detailPayload.campaign.recipients ?? []).map((recipient) => normalizeRecipient(recipient)));
          setRefreshError("");
        }
      } else {
        const detail = (payload as CampaignDetailPayload).campaign;
        if (!detail?.campaign) throw new Error("Campaign updates are unavailable. Displayed results may be out of date.");
        setLiveCampaign(normalizeCampaign(detail.campaign));
        setLiveRecipients((detail.recipients ?? []).map((recipient) => normalizeRecipient(recipient)));
        setRefreshError("");
      }
      setLastSyncedAt(new Date().toISOString());
    } catch (refreshFailure) {
      if (!controller.signal.aborted && activeCampaignIdRef.current === campaignId) {
        setRefreshError(refreshFailure instanceof Error ? refreshFailure.message : "Unable to refresh campaign");
      }
    } finally {
      if (refreshControllersRef.current.get(requestKey) === controller) refreshControllersRef.current.delete(requestKey);
      if (activeCampaignIdRef.current === campaignId) setIsRefreshingLive(refreshControllersRef.current.size > 0);
    }
  }, []);

  const refreshCampaignDetails = useCallback((campaignId: string) => refreshCampaign(campaignId), [refreshCampaign]);

  function scheduleRecipientRefresh(campaignId: string, delayMs = 1200) {
    if (detailRefreshTimeoutRef.current !== null) window.clearTimeout(detailRefreshTimeoutRef.current);
    detailRefreshTimeoutRef.current = window.setTimeout(() => {
      detailRefreshTimeoutRef.current = null;
      void refreshCampaignDetails(campaignId);
    }, delayMs);
  }

  useEffect(() => {
    const shouldPoll =
      liveCampaign.status === "SENDING" ||
      liveCampaign.status === "SCHEDULED" ||
      liveCampaign.status === "PAUSED";
    if (!shouldPoll) return;

    const intervalId = window.setInterval(() => {
      void refreshCampaign(liveCampaign.id, true);
    }, 8000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [liveCampaign.id, liveCampaign.status, refreshCampaign]);

  useEffect(() => {
    const shouldReconcileRecipients =
      liveCampaign.status === "SENDING" ||
      liveCampaign.status === "SCHEDULED" ||
      liveCampaign.status === "PAUSED";
    if (!shouldReconcileRecipients) return;

    const intervalId = window.setInterval(() => {
      void refreshCampaignDetails(liveCampaign.id);
    }, 10000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [liveCampaign.id, liveCampaign.status, refreshCampaignDetails]);

  useWhatsappRealtimeSubscription((payload) => {
    if (payload.type !== "campaign.updated" || payload.campaignId !== liveCampaign.id) {
      return;
    }

    setLiveCampaign((current) => mergeCampaignRealtimeSummary(current, payload.campaign));
    setLastSyncedAt(new Date().toISOString());
    scheduleRecipientRefresh(payload.campaignId);
  });

  useEffect(() => {
    return () => {
      if (detailRefreshTimeoutRef.current !== null) {
        window.clearTimeout(detailRefreshTimeoutRef.current);
      }
    };
  }, []);

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
  const processingCount = recipientCounts.PROCESSING || 0;
  const activeQueueCount = queuedCount + processingCount;
  const pendingCount = recipientCounts.PENDING || 0;
  const processedCount = Math.max(effectiveCampaign.totalRecipients - activeQueueCount - pendingCount, 0);
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
  const selectableSendMoreCount = sendMoreContacts.filter((contact) => pendingRecipientContactIds.includes(contact.contactId) && !excludedContactIds.includes(contact.contactId)).length;
  const currentSendMoreBatchSize = Math.min(
    Math.max(Number.parseInt(sendMoreBatchSize || "0", 10) || 0, 0),
    selectableSendMoreCount,
  );
  const previewBodyParameters = useMemo(
    () => (previewRecipient ? resolveBodyParameters(previewRecipient, liveCampaign.variableMappings) : []),
    [liveCampaign.variableMappings, previewRecipient],
  );
  async function runAction(kind: "launch" | "pause" | "resume" | "cancel" | "retry_failed" | "repair_status") {
    if (mutationRef.current) return;
    if (kind === "launch" && (!launchScheduleValid || currentLaunchBatchSize <= 0)) {
      setError("Choose a valid future date and a batch of at least one recipient.");
      return;
    }
    mutationRef.current = true;
    refreshControllersRef.current.forEach((controller) => controller.abort());
    refreshControllersRef.current.clear();
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
            ? JSON.stringify({ batchSize: currentLaunchBatchSize, scheduledAt: launchTiming === "later" ? selectedLaunchInstant : null })
            : JSON.stringify({ action: kind }),
      });
      const body = await response.json().catch(() => ({}));
      if (activeCampaignIdRef.current !== liveCampaign.id) return;
      if (!response.ok) {
        throw new Error(body.error || `Failed to ${kind.replace("_", " ")} campaign`);
      }

      const nextNotice =
        kind === "launch"
          ? `${launchTiming === "later" ? "Scheduled" : "Queued"} ${body.queuedRecipients ?? currentLaunchBatchSize} recipients.`
          : kind === "pause"
            ? "Campaign paused."
            : kind === "resume"
              ? "Campaign resumed."
              : kind === "cancel"
                ? "Campaign cancelled."
                : kind === "retry_failed"
                  ? "Failed recipients queued again."
                  : "Campaign status repaired.";

      toast.success(nextNotice);
      setConfirmAction(null);
      await refreshCampaignDetails(liveCampaign.id);
    } catch (actionError) {
      if (activeCampaignIdRef.current !== liveCampaign.id) return;
      setError(actionError instanceof Error ? actionError.message : "Campaign action failed");
    } finally {
      mutationRef.current = false;
      setLoadingAction(null);
    }
  }

  async function openSendMoreModal() {
    if (loadingAction || loadingSendMore || sendMoreControllerRef.current) return;
    if (!liveCampaign.listLabel) {
      setError("This campaign has no locked contact list.");
      return;
    }

    const controller = new AbortController();
    sendMoreControllerRef.current = controller;
    setLoadingSendMore(true);
    setError("");
    setNotice("");

    try {
      const contacts: SendMoreContact[] = [];
      let total = Infinity;
      while (contacts.length < total) {
        const query = new URLSearchParams({ listLabel: liveCampaign.listLabel, limit: "500", cursor: String(contacts.length) });
        const response = await fetch(apiUrl(`/api/whatsapp/contacts?${query}`), {
          credentials: "include", cache: "no-store", signal: controller.signal,
        });
        const body = await response.json().catch(() => ({})) as {
          contacts?: Array<Partial<SendMoreContact> & Record<string, unknown>>;
          stats?: { filteredTotal?: number };
          error?: string;
        };
        if (!response.ok) throw new Error(body.error || "Failed to load contacts");
        if (controller.signal.aborted || activeCampaignIdRef.current !== liveCampaign.id) return;
        const page = (body.contacts ?? []).map((contact) => ({
          id: String(contact.id ?? ""),
          contactId: String(contact.contactId ?? contact.contact_id ?? ""),
          phone: String(contact.phone ?? ""),
          fullName: (contact.fullName ?? contact.full_name ?? null) as string | null,
          location: contact.location ?? null,
          listLabel: String(contact.listLabel ?? contact.list_label ?? liveCampaign.listLabel),
          metadata: contact.metadata ?? null,
        }));
        total = Number(body.stats?.filteredTotal ?? contacts.length + page.length);
        if (page.some((contact) => !contact.id || !contact.contactId) || (!page.length && contacts.length < total)) {
          throw new Error("Contact list changed or is incomplete. Close and try again.");
        }
        contacts.push(...page);
      }
      if (new Set(contacts.map((contact) => contact.id)).size !== contacts.length) throw new Error("Contact list changed. Close and try again.");
      if (controller.signal.aborted || activeCampaignIdRef.current !== liveCampaign.id) return;
      const recipientIds = liveRecipients
        .filter((recipient) => recipient.status === "PENDING")
        .map((recipient) => recipient.contactId)
        .filter(Boolean);
      const availableCount = contacts.filter((contact) => recipientIds.includes(contact.contactId)).length;

      setSendMoreContacts(contacts);
      setPendingRecipientContactIds(recipientIds);
      setExcludedContactIds([]);
      setSendMoreSearch("");
      setSendMoreBatchSize(String(Math.min(liveCampaign.defaultBatchSize || 200, availableCount)));
      setSendMoreOpen(true);
    } catch (actionError) {
      if (controller.signal.aborted || activeCampaignIdRef.current !== liveCampaign.id) return;
      setError(actionError instanceof Error ? actionError.message : "Failed to load send more details");
    } finally {
      if (sendMoreControllerRef.current === controller) sendMoreControllerRef.current = null;
      if (activeCampaignIdRef.current === liveCampaign.id) setLoadingSendMore(false);
    }
  }

  async function confirmSendMore() {
    if (currentSendMoreBatchSize <= 0) {
      setError("Select at least one contact for the next batch.");
      return;
    }

    if (mutationRef.current) return;
    mutationRef.current = true;
    refreshControllersRef.current.forEach((controller) => controller.abort());
    refreshControllersRef.current.clear();
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
      if (activeCampaignIdRef.current !== liveCampaign.id) return;
      if (!response.ok) {
        throw new Error(body.error || "Failed to send next batch");
      }
      toast.success(`Queued ${body.queuedRecipients ?? currentSendMoreBatchSize} more recipients`);
      setSendMoreOpen(false);
      await refreshCampaignDetails(liveCampaign.id);
    } catch (actionError) {
      if (activeCampaignIdRef.current !== liveCampaign.id) return;
      setError(actionError instanceof Error ? actionError.message : "Send more failed");
    } finally {
      mutationRef.current = false;
      setLoadingAction(null);
    }
  }

  async function deleteCampaign() {
    if (mutationRef.current) return;
    mutationRef.current = true;
    refreshControllersRef.current.forEach((controller) => controller.abort());
    refreshControllersRef.current.clear();
    setLoadingAction("delete");
    setError("");
    setNotice("");
    try {
      const response = await fetch(apiUrl(`/api/whatsapp/campaigns/${liveCampaign.id}`), {
        method: "DELETE",
        credentials: "include",
      });
      const body = await response.json().catch(() => ({}));
      if (activeCampaignIdRef.current !== liveCampaign.id) return;
      if (!response.ok) {
        throw new Error(body.error || "Failed to delete campaign");
      }
      toast.success("Campaign deleted");
      navigate("/campaigns");
    } catch (actionError) {
      if (activeCampaignIdRef.current !== liveCampaign.id) return;
      setError(actionError instanceof Error ? actionError.message : "Failed to delete campaign");
    } finally {
      mutationRef.current = false;
      setLoadingAction(null);
    }
  }

  const selectedRecipient = liveRecipients.find((recipient) => recipient.id === selectedRecipientId) ?? null;
  const failedRecipientsCount = (recipientCounts.FAILED || 0) + (recipientCounts.BLOCKED || 0);
  const skippedRecipientsCount = (recipientCounts.SKIPPED || 0) + (recipientCounts.UNSUBSCRIBED || 0);
  const filteredRecipients = liveRecipients.filter((recipient) => {
    if (recipientTab === "failed" && !["FAILED", "BLOCKED"].includes(recipient.status)) return false;
    if (recipientTab === "skipped" && !["SKIPPED", "UNSUBSCRIBED"].includes(recipient.status)) return false;
    if (recipientFilter !== "ALL" && recipient.status !== recipientFilter) return false;
    const needle = recipientSearch.trim().toLowerCase();
    return !needle || [recipient.contactFullName, recipient.contactPhone, recipient.contactLocation, recipient.contactListLabel].filter(Boolean).join(" ").toLowerCase().includes(needle);
  });

  const launchable =
    (liveCampaign.status === "DRAFT" && pendingCount > 0) ||
    ((liveCampaign.status === "COMPLETED" || liveCampaign.status === "FAILED") &&
      pendingCount > 0 &&
      activeQueueCount === 0 &&
      !hasProcessedRecipients);
  const pausable = liveCampaign.status === "SENDING" || liveCampaign.status === "SCHEDULED";
  const resumable = liveCampaign.status === "PAUSED";
  const idleSendingWithPending = liveCampaign.status === "SENDING" && activeQueueCount === 0 && pendingCount > 0;
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

  function finishMenuAction(event: Event) {
    const action = menuActionRef.current;
    if (!action) return;
    event.preventDefault();
    menuActionRef.current = null;
    // Open the next focus trap after the menu releases its focus and pointer locks.
    menuActionFrameRef.current = window.requestAnimationFrame(() => {
      menuActionFrameRef.current = null;
      if (activeCampaignIdRef.current === liveCampaign.id) action();
    });
  }

  const busy = Boolean(loadingAction) || loadingSendMore;
  const retryable = effectiveCampaign.failedCount > 0 && !["SENDING", "SCHEDULED"].includes(liveCampaign.status);
  const progress = effectiveCampaign.totalRecipients > 0 ? Math.round((processedCount / effectiveCampaign.totalRecipients) * 100) : 0;
  const recipientInspector = selectedRecipient ? (
    <div className="campaign-detail__contact">
      <div className="campaign-detail__section-heading"><h3>Selected contact</h3><Button variant="ghost" size="icon-sm" aria-label="Clear selected contact" onClick={() => setSelectedRecipientId(null)}><X size={16} /></Button></div>
      <strong>{selectedRecipient.contactFullName || selectedRecipient.contactPhone}</strong>
      <a href={whatsappLink(selectedRecipient.contactPhone)} target="_blank" rel="noreferrer"><Phone size={15} />{selectedRecipient.contactPhone}</a>
      <Badge className={recipientTone(selectedRecipient.status)}>{displayStatus(selectedRecipient.status)}</Badge>
      <dl className="campaign-detail__details">
        <InfoRow label="List" value={selectedRecipient.contactListLabel} />
        <InfoRow label="Location" value={selectedRecipient.contactLocation || "—"} />
        <InfoRow label="Sent" value={formatDate(selectedRecipient.sentAt)} />
        <InfoRow label="Delivered" value={formatDate(selectedRecipient.deliveredAt)} />
        <InfoRow label="Read" value={formatDate(selectedRecipient.readAt)} />
        <InfoRow label="Failed" value={formatDate(selectedRecipient.failedAt)} />
        {Object.entries(selectedRecipient.contactMetadata ?? {}).map(([key, value]) => <InfoRow key={key} label={key} value={value} />)}
      </dl>
      {recipientErrorText(selectedRecipient) && <button className="campaign-detail__failure" onClick={() => setErrorPreviewRecipient(selectedRecipient)}>{recipientErrorText(selectedRecipient)}<span>View error</span></button>}
      <Button variant="outline" size="sm" onClick={() => setPreviewRecipient(selectedRecipient)}>View message</Button>
    </div>
  ) : null;

  return (
    <MotionReveal className="campaign-detail">
      <header className="campaign-detail__header">
        <div className="campaign-detail__identity">
          <Link to="/campaigns" className="campaign-detail__back" aria-label="Back to campaigns"><ArrowLeft size={18} /></Link>
          <div><div className="campaign-detail__title"><h1>{liveCampaign.name}</h1><Badge className={statusTone(liveCampaign.status)}>{displayStatus(liveCampaign.status)}</Badge></div>
            <p>{liveCampaign.description || liveCampaign.templateName}<span>·</span>Created {formatDate(liveCampaign.createdAt)}</p>
          </div>
        </div>
        <div className="campaign-detail__actions">
          {launchable && <Button disabled={busy || currentLaunchBatchSize <= 0} onClick={() => setConfirmAction("launch")}><Send size={16} />Launch batch</Button>}
          {pausable && <Button variant="outline" disabled={busy} onClick={() => void runAction("pause")}>{loadingAction === "pause" ? "Pausing..." : "Pause"}</Button>}
          {resumable && <Button disabled={busy} onClick={() => void runAction("resume")}>{loadingAction === "resume" ? "Resuming..." : "Resume"}</Button>}
          {sendMoreable && pendingCount > 0 && <Button variant="outline" disabled={busy} onClick={() => void openSendMoreModal()}>{loadingSendMore ? "Loading..." : "Send more"}</Button>}
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" disabled={busy}>More<ChevronDown size={15} /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" onCloseAutoFocus={finishMenuAction}>
            {retryable && <DropdownMenuItem onSelect={() => { menuActionRef.current = () => setConfirmAction("retry_failed"); }}>Retry failed</DropdownMenuItem>}
            <DropdownMenuItem onSelect={() => void refreshCampaignDetails(liveCampaign.id)} disabled={isRefreshingLive}>Refresh results</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void runAction("repair_status")}>Repair status</DropdownMenuItem>
            {(cancellable || deletable) && <DropdownMenuSeparator />}
            {cancellable && <DropdownMenuItem variant="destructive" onSelect={() => { menuActionRef.current = () => setConfirmAction("cancel"); }}>Cancel campaign</DropdownMenuItem>}
            {deletable && <DropdownMenuItem variant="destructive" onSelect={() => { menuActionRef.current = () => setConfirmDelete(true); }}>Delete campaign</DropdownMenuItem>}
          </DropdownMenuContent></DropdownMenu>
          <AskGrowthAgent featureId="campaigns" context={{ kind: "whatsapp_campaign", resourceId: liveCampaign.id }}>Ask agent</AskGrowthAgent>
        </div>
      </header>
      {error && !confirmAction && !confirmDelete && !sendMoreOpen && <div role="alert" className="campaign-detail__alert">{error}</div>}
      {notice && <div role="status" className="campaign-detail__notice">{notice}</div>}
      {refreshError && <div role="status" className="campaign-detail__stale"><span>{refreshError}</span><Button variant="outline" size="sm" disabled={isRefreshingLive} onClick={() => void refreshCampaignDetails(liveCampaign.id)}><RotateCcw size={14} />Retry refresh</Button></div>}
      <div className="campaign-detail__workspace">
        <main className="campaign-detail__main">
          <section className="campaign-detail__metrics" aria-label="Delivery summary">
            <MetricCard label="Recipients" value={effectiveCampaign.totalRecipients} />
            <MetricCard label="Sent" value={effectiveCampaign.sentCount} />
            <MetricCard label="Delivered" value={effectiveCampaign.deliveredCount} />
            <MetricCard label="Read" value={effectiveCampaign.readCount} />
            <MetricCard label="Failed" value={effectiveCampaign.failedCount + effectiveCampaign.blockedCount} />
            <MetricCard label="Remaining" value={remaining} />
          </section>
          <div className="campaign-detail__progress"><div><span>{processedCount.toLocaleString("en-ZA")} of {effectiveCampaign.totalRecipients.toLocaleString("en-ZA")} processed</span><span>{progress}%</span></div><Progress value={progress} /><div><span>{activeQueueCount} queued or processing · {pendingCount} pending</span><span>{isRefreshingLive ? "Refreshing..." : `Synced ${formatDate(lastSyncedAt)}`}</span></div></div>
          <nav className="campaign-detail__tabs" aria-label="Recipient groups">
            {[{ id: "all", label: "Recipients", count: liveRecipients.length }, { id: "failed", label: "Failed", count: failedRecipientsCount }, { id: "skipped", label: "Skipped", count: skippedRecipientsCount }].map((tab) => <button type="button" key={tab.id} aria-current={recipientTab === tab.id ? "page" : undefined} onClick={() => { setRecipientTab(tab.id); setRecipientFilter("ALL"); }}>{tab.label}<span>{tab.count}</span></button>)}
          </nav>
          <div className="campaign-detail__toolbar"><label className="campaign-detail__search"><Search size={16} /><Input aria-label="Search recipients" placeholder="Search recipients..." value={recipientSearch} onChange={(event) => setRecipientSearch(event.target.value)} /></label><select aria-label="Recipient status" value={recipientFilter} onChange={(event) => setRecipientFilter(event.target.value)}><option value="ALL">All statuses</option>{["PENDING", "QUEUED", "PROCESSING", "SENT", "DELIVERED", "READ", "FAILED", "BLOCKED", "SKIPPED", "UNSUBSCRIBED"].map((status) => <option key={status} value={status}>{displayStatus(status)}</option>)}</select></div>
          <div className="campaign-detail__table-scroll"><table className="campaign-detail__table"><thead><tr><th>Name</th><th>Phone</th><th>Status</th><th>Sent</th><th>Delivered</th><th><span className="sr-only">Recipient actions</span><MoreHorizontal size={17} /></th></tr></thead><tbody>
            {filteredRecipients.map((recipient) => <tr key={recipient.id} data-selected={selectedRecipientId === recipient.id}>
              <td><button className="campaign-detail__contact-button" onClick={() => setSelectedRecipientId(recipient.id)}>{recipient.contactFullName || recipient.contactPhone}<span>{recipient.contactListLabel}</span></button></td>
              <td><a href={whatsappLink(recipient.contactPhone)} target="_blank" rel="noreferrer">{recipient.contactPhone}</a></td>
              <td><Badge className={recipientTone(recipient.status)}>{displayStatus(recipient.status)}</Badge></td>
              <td>{formatDate(recipient.sentAt)}</td><td>{formatDate(recipient.deliveredAt)}</td>
              <td><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${recipient.contactFullName || recipient.contactPhone}`}><MoreHorizontal size={17} /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" onCloseAutoFocus={finishMenuAction}><DropdownMenuItem onSelect={() => { menuActionRef.current = () => setSelectedRecipientId(recipient.id); }}>View contact</DropdownMenuItem><DropdownMenuItem onSelect={() => { menuActionRef.current = () => setPreviewRecipient(recipient); }}>View message</DropdownMenuItem>{recipientErrorText(recipient) && <DropdownMenuItem onSelect={() => { menuActionRef.current = () => setErrorPreviewRecipient(recipient); }}>View error</DropdownMenuItem>}</DropdownMenuContent></DropdownMenu></td>
            </tr>)}
          </tbody></table></div>
          <div className="campaign-detail__mobile-recipients">{filteredRecipients.map((recipient) => <button type="button" key={recipient.id} onClick={() => setSelectedRecipientId(recipient.id)}><div><strong>{recipient.contactFullName || recipient.contactPhone}</strong><span>{recipient.contactPhone}</span></div><Badge className={recipientTone(recipient.status)}>{displayStatus(recipient.status)}</Badge></button>)}</div>
          {filteredRecipients.length === 0 && <div className="campaign-detail__empty"><Users size={24} /><h2>{liveRecipients.length ? "No matching recipients" : "No recipients"}</h2>{liveRecipients.length > 0 && <Button variant="outline" size="sm" onClick={() => { setRecipientSearch(""); setRecipientFilter("ALL"); setRecipientTab("all"); }}>Clear filters</Button>}</div>}
          <footer className="campaign-detail__table-footer">{filteredRecipients.length.toLocaleString("en-ZA")} of {liveRecipients.length.toLocaleString("en-ZA")} recipients</footer>
        </main>
        <aside className="campaign-detail__inspector" aria-label="Campaign details">
          <h2>Template preview</h2>
          <TemplateMessage campaign={liveCampaign} recipient={selectedRecipient} />
          {recipientInspector}
          <section className="campaign-detail__campaign-info"><h3>Campaign details</h3><dl className="campaign-detail__details"><InfoRow label="Connection" value={liveCampaign.connectionLabel || "No connection"} /><InfoRow label="Template" value={liveCampaign.templateName} /><InfoRow label="Language" value={liveCampaign.templateLanguage} /><InfoRow label="Template status" value={liveCampaign.templateStatus || "—"} /><InfoRow label="List" value={liveCampaign.listLabel || "default"} /><InfoRow label="Scheduled" value={formatDate(liveCampaign.scheduledAt)} /><InfoRow label="Launched" value={formatDate(liveCampaign.launchedAt)} /><InfoRow label="Completed" value={formatDate(liveCampaign.completedAt)} /><InfoRow label="Updated" value={formatDate(liveCampaign.updatedAt)} /></dl></section>
        </aside>
      </div>
      <Sheet open={Boolean(selectedRecipient) && !wideInspector} onOpenChange={(open) => { if (!open) setSelectedRecipientId(null); }}><SheetContent className="campaign-detail__recipient-sheet"><SheetHeader><SheetTitle>Recipient details</SheetTitle><SheetDescription>{selectedRecipient?.contactFullName || selectedRecipient?.contactPhone}</SheetDescription></SheetHeader>{recipientInspector}{selectedRecipient && <TemplateMessage campaign={liveCampaign} recipient={selectedRecipient} />}</SheetContent></Sheet>
        <Dialog open={confirmDelete} onOpenChange={(open) => { if (!loadingAction) setConfirmDelete(open); }}>
          <DialogContent><DialogHeader><DialogTitle>Delete campaign?</DialogTitle><DialogDescription>Delete {liveCampaign.name} and its campaign history. This cannot be undone.</DialogDescription></DialogHeader>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2"><Button variant="outline" disabled={Boolean(loadingAction)} onClick={() => setConfirmDelete(false)}>Cancel</Button><Button variant="destructive" disabled={Boolean(loadingAction)} onClick={() => void deleteCampaign()}>{loadingAction ? "Deleting..." : "Delete campaign"}</Button></div>
          </DialogContent>
        </Dialog>
        <Dialog open={Boolean(confirmAction)} onOpenChange={(open) => { if (!open && !loadingAction) { setConfirmAction(null); setError(""); } }}>
          <DialogContent>
            <DialogHeader><DialogTitle>{confirmAction === "launch" ? "Review launch" : confirmAction === "retry_failed" ? "Retry failed recipients?" : "Cancel campaign?"}</DialogTitle><DialogDescription>{confirmAction === "launch" ? `${currentLaunchBatchSize} recipients · ${liveCampaign.templateName} · ${liveCampaign.connectionLabel || "No connection"}` : confirmAction === "retry_failed" ? `${effectiveCampaign.failedCount} failed recipients will be queued again. Delivered recipients are excluded.` : "Pending and queued messages will be cancelled. Messages already sent cannot be recalled."}</DialogDescription></DialogHeader>
            {confirmAction === "launch" && <div className="space-y-4">
              <label className="grid gap-2 text-sm">Batch size<Input type="number" min={1} max={remaining || 1} value={launchBatchSize} onChange={(event) => setLaunchBatchSize(event.target.value)} /></label>
              <label className="grid gap-2 text-sm">Send time<select className="h-10 rounded-md border border-input bg-background px-3" value={launchTiming} onChange={(event) => setLaunchTiming(event.target.value as "now" | "later")}><option value="now">Send now</option><option value="later">Schedule</option></select></label>
              {launchTiming === "later" && <>
                <label className="grid gap-2 text-sm">Date and time<Input type="datetime-local" value={launchDate} onChange={(event) => { setLaunchDate(event.target.value); setLaunchOccurrence(""); }} /></label>
                <label className="grid gap-2 text-sm">Timezone<select className="h-10 min-w-0 rounded-md border border-input bg-background px-3" value={launchTimeZone} onChange={(event) => { setLaunchTimeZone(event.target.value); setLaunchOccurrence(""); }}>{timeZoneOptions(launchTimeZone).map((zone) => <option key={zone}>{zone}</option>)}</select></label>
                {launchInstants.length > 1 && <label className="grid gap-2 text-sm">Clock change<select className="h-10 rounded-md border border-input bg-background px-3" value={launchOccurrence} onChange={(event) => setLaunchOccurrence(event.target.value)}><option value="">Choose occurrence</option>{launchInstants.map((instant) => <option key={instant} value={instant}>{new Intl.DateTimeFormat("en-ZA", { timeZone: launchTimeZone, dateStyle: "medium", timeStyle: "long" }).format(new Date(instant))}</option>)}</select></label>}
                {!launchScheduleValid && launchDate && <p className="text-sm text-destructive">Choose a future time that exists in this timezone.</p>}
                {selectedLaunchInstant && <p className="text-xs text-muted-foreground">{new Intl.DateTimeFormat("en-ZA", { timeZone: launchTimeZone, dateStyle: "full", timeStyle: "long" }).format(new Date(selectedLaunchInstant))}</p>}
              </>}
            </div>}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2"><Button variant="outline" disabled={Boolean(loadingAction)} onClick={() => { setConfirmAction(null); setError(""); }}>Back</Button><Button variant={confirmAction === "cancel" ? "destructive" : "default"} disabled={Boolean(loadingAction) || (confirmAction === "launch" && (!launchScheduleValid || currentLaunchBatchSize <= 0))} onClick={() => { if (confirmAction) void runAction(confirmAction); }}>{loadingAction ? "Saving..." : confirmAction === "launch" ? launchTiming === "later" ? "Schedule campaign" : "Queue campaign" : confirmAction === "retry_failed" ? "Retry failed" : "Cancel campaign"}</Button></div>
          </DialogContent>
        </Dialog>
        <Dialog open={Boolean(previewRecipient)} onOpenChange={(open) => { if (!open) setPreviewRecipient(null); }}>
          {previewRecipient && <DialogContent className="campaign-detail__dialog campaign-detail__template-dialog max-h-[calc(100svh-2rem)] max-w-3xl overflow-auto">
            <DialogHeader><DialogTitle>Template preview</DialogTitle><DialogDescription>{previewRecipient.contactFullName || previewRecipient.contactPhone} · {liveCampaign.templateName} · {liveCampaign.templateLanguage}</DialogDescription></DialogHeader>
            <div className="campaign-detail__template-columns"><TemplateMessage campaign={liveCampaign} recipient={previewRecipient} /><section><h3>Resolved parameters</h3><dl className="campaign-detail__details">{previewBodyParameters.length ? previewBodyParameters.map((value, index) => <InfoRow key={index} label={`{{${index + 1}}} · ${liveCampaign.variableMappings?.[index]?.source === "static" ? "Static text" : liveCampaign.variableMappings?.[index]?.key || "Variable"}`} value={value || "Empty value"} />) : <p className="text-xs text-muted-foreground">No body variables</p>}</dl><h3>Recipient context</h3><dl className="campaign-detail__details"><InfoRow label="Phone" value={previewRecipient.contactPhone} /><InfoRow label="Name" value={previewRecipient.contactFullName || "—"} /><InfoRow label="Location" value={previewRecipient.contactLocation || "—"} /><InfoRow label="Status" value={displayStatus(previewRecipient.status)} /></dl></section></div>
          </DialogContent>}
        </Dialog>
        <Dialog open={Boolean(errorPreviewRecipient)} onOpenChange={(open) => { if (!open) setErrorPreviewRecipient(null); }}>
          {errorPreviewRecipient && <DialogContent className="campaign-detail__dialog max-h-[calc(100svh-2rem)] max-w-xl overflow-auto">
            <DialogHeader><DialogTitle>Delivery failure</DialogTitle><DialogDescription>{errorPreviewRecipient.contactFullName || errorPreviewRecipient.contactPhone} · {errorPreviewRecipient.contactPhone}</DialogDescription></DialogHeader>
            <dl className="campaign-detail__details"><InfoRow label="Status" value={displayStatus(errorPreviewRecipient.status)} /><InfoRow label="Failed at" value={formatDate(errorPreviewRecipient.failedAt)} /><InfoRow label="Error code" value={errorPreviewRecipient.errorCode || "—"} /></dl><section className="campaign-detail__error-message"><h3>Full error</h3><p>{recipientErrorText(errorPreviewRecipient) || "—"}</p></section>
          </DialogContent>}
        </Dialog>
        <Dialog open={sendMoreOpen} onOpenChange={(open) => { if (!loadingAction) setSendMoreOpen(open); }}>
          {sendMoreOpen ? (
            <DialogContent className="campaign-detail__dialog campaign-detail__sendmore max-h-[calc(100svh-2rem)] overflow-auto p-6">
              <div className="flex items-start justify-between gap-4">
                <DialogHeader>
                  <DialogTitle>Send more: {liveCampaign.name}</DialogTitle>
                  <DialogDescription>
                    Locked list: {liveCampaign.listLabel || "default"} · Already sent: {effectiveCampaign.sentCount} · Delivered:{" "}
                    {effectiveCampaign.deliveredCount} · Read: {effectiveCampaign.readCount}. Exclusions permanently skip recipients in this campaign.
                  </DialogDescription>
                </DialogHeader>
              </div>

              <div className="campaign-detail__batch-metrics">
                <div>
                  <div className="text-xs text-muted-foreground">Original recipients</div>
                  <div className="mt-1 text-xl font-semibold">{effectiveCampaign.totalRecipients}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Pending in campaign</div>
                  <div className="mt-1 text-xl font-semibold">{pendingRecipientContactIds.length}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Remaining available</div>
                  <div className="mt-1 text-xl font-semibold">{selectableSendMoreCount}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">This next batch</div>
                  <div className="mt-1 text-xl font-semibold">{currentSendMoreBatchSize}</div>
                </div>
              </div>

              <div className="campaign-detail__sendmore-columns">
                <div className="space-y-3">
                  <div className="campaign-detail__sendmore-controls">
                    <Input disabled={Boolean(loadingAction)}
                      aria-label="Search remaining contacts" placeholder="Search remaining contacts..."
                      value={sendMoreSearch}
                      onChange={(event) => setSendMoreSearch(event.target.value)}
                    />
                    <Input disabled={Boolean(loadingAction)}
                      type="number"
                      min={1}
                      aria-label="Next batch size" max={selectableSendMoreCount || 1}
                      value={sendMoreBatchSize}
                      onChange={(event) => setSendMoreBatchSize(event.target.value)}
                    />
                  </div>

                  <div className="campaign-detail__sendmore-list">
                    {sendMoreAvailableContacts.map((contact) => {
                      const excluded = excludedContactIds.includes(contact.contactId);
                      return (
                        <div
                          key={contact.id}
                          className="campaign-detail__sendmore-row"
                        >
                          <div className="min-w-0">
                            <div className="font-medium text-foreground">{contact.fullName || contact.phone}</div>
                            <div className="campaign-detail__sendmore-secondary">
                              {contact.phone}
                              {contact.location ? ` · ${contact.location}` : ""}
                            </div>
                          </div>
                          <Button
                            type="button"
                            disabled={Boolean(loadingAction)} aria-pressed={excluded} variant={excluded ? "secondary" : "outline"}
                            size="sm"
                            onClick={() =>
                              setExcludedContactIds((current) =>
                                current.includes(contact.contactId)
                                  ? current.filter((value) => value !== contact.contactId)
                                  : [...current, contact.contactId],
                              )
                            }
                          >
                            {excluded ? "Include" : "Exclude"}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="campaign-detail__sendmore-exclusions">
                  <h3 className="text-sm font-semibold text-foreground">Excluded from campaign</h3>
                  <div className="mt-3 space-y-2">
                    {excludedContactIds.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No contacts excluded.</p>
                    ) : (
                      excludedSendMoreContacts.map((contact) => (
                          <div
                            key={contact.id}
                            className="campaign-detail__sendmore-row"
                          >
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-foreground">
                                {contact.fullName || contact.phone}
                              </div>
                              <div className="campaign-detail__sendmore-secondary">{contact.phone}</div>
                            </div>
                            <Button
                              type="button" disabled={Boolean(loadingAction)}
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                setExcludedContactIds((current) => current.filter((value) => value !== contact.contactId))
                              }
                            >
                              Include
                            </Button>
                          </div>
                        ))
                    )}
                  </div>
                </div>
              </div>

              {excludedContactIds.length > 0 && <p className="mt-4 text-sm text-muted-foreground">{excludedContactIds.length} recipients will be permanently skipped in this campaign.</p>}
              {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
              <div className="mt-6 flex justify-end gap-3">
                <Button variant="outline" disabled={Boolean(loadingAction)} onClick={() => setSendMoreOpen(false)}>
                  Cancel
                </Button>
                <Button
                  disabled={Boolean(loadingAction) || loadingSendMore || currentSendMoreBatchSize <= 0}
                  onClick={() => void confirmSendMore()}
                >
                  {loadingAction ? "Queueing..." : "Send next batch"}
                </Button>
              </div>
            </DialogContent>
          ) : null}
        </Dialog>
    </MotionReveal>
  );
}

function displayStatus(status: string) {
  return status.charAt(0) + status.slice(1).toLowerCase().replaceAll("_", " ");
}

function MetricCard({ label, value }: { label: string; value: number | null | undefined }) {
  return <div className="campaign-detail__metric"><span>{label}</span><strong>{Number(value ?? 0).toLocaleString("en-ZA")}</strong></div>;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function TemplateMessage({ campaign, recipient }: { campaign: Campaign; recipient: CampaignRecipient | null }) {
  const body = recipient ? renderTemplateBody(campaign.templateBody, resolveBodyParameters(recipient, campaign.variableMappings)) : campaign.templateBody;
  const buttons = (campaign.templateButtons ?? []).flatMap((button) => {
    if (!button || typeof button !== "object") return [];
    const text = (button as { text?: unknown }).text;
    return typeof text === "string" ? [text] : [];
  });
  return <div className="campaign-detail__message-stage"><div className="campaign-detail__message">
    {campaign.templateHeader && <strong>{campaign.templateHeader}</strong>}
    <p>{body || "No template body available"}</p>
    {campaign.templateFooter && <small>{campaign.templateFooter}</small>}
    {buttons.map((text, index) => <div key={`${text}-${index}`} className="campaign-detail__message-button">{text}</div>)}
  </div></div>;
}
