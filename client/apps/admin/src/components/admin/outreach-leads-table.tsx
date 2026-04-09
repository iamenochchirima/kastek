"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useEffect } from "react";
import ConfirmModal from "./confirm-modal";
import EditFieldModal from "./edit-field-modal";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-white/5 text-text-faint",
  sent: "bg-blue-500/15 text-blue-400",
  replied: "bg-purple-500/15 text-purple-400",
  interested: "bg-green-500/15 text-green-400",
  not_interested: "bg-yellow-500/15 text-yellow-400",
  bounced: "bg-red-500/15 text-red-400",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  sent: "Sent",
  replied: "Replied",
  interested: "Interested",
  not_interested: "Not Interested",
  bounced: "Bounced",
};

const EMAIL_STATUSES = [
  "pending",
  "sent",
  "replied",
  "interested",
  "not_interested",
  "bounced",
];

type Lead = {
  id: string;
  campaignId: string;
  businessName: string;
  website: string | null;
  address: string | null;
  emailStatus: string;
  emailAddress: string | null;
  phone: string | null;
  emailTemplate: string | null;
  emailSentAt: string | null;
  followUpCount: number;
  nextFollowUp: string | null;
  notes: string | null;
  sendToEmails?: string[];
};

export default function OutreachLeadsTable({
  leads,
  campaignId,
}: {
  leads: Lead[];
  campaignId: string;
}) {
  const router = useRouter();
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [updating, setUpdating] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showBulkSendModal, setShowBulkSendModal] = useState(false);
  const [bulkMode, setBulkMode] = useState<"selected" | "all">("all");
  const [bulkSending, setBulkSending] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [bulkSentLeadIds, setBulkSentLeadIds] = useState<Set<string>>(new Set());
  const [bulkCooldownSeconds, setBulkCooldownSeconds] = useState<number | null>(null);
  const [bulkStopping, setBulkStopping] = useState(false);
  const [bulkRunMode, setBulkRunMode] = useState<"selected" | "all" | null>(null);
  const [bulkRunRequestedCount, setBulkRunRequestedCount] = useState(0);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [allCampaignLeads, setAllCampaignLeads] = useState<Lead[] | null>(null);
  const [loadingAllLeads, setLoadingAllLeads] = useState(false);
  const [allLeadsError, setAllLeadsError] = useState<string | null>(null);
  const [showDebugModal, setShowDebugModal] = useState(false);
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugData, setDebugData] = useState<{
    matched: number;
    unmatched: number;
    dbLeadsChecked: number;
    debugSamples: Array<{
      businessName: string;
      dbWebsite: string | null;
      normalizedDbKey: string;
      matched: boolean;
      draftWebsite: string | null;
      dbHasEmail: boolean;
      dbHasTemplate: boolean;
      dbHasSubject: boolean;
    }>;
  } | null>(null);

  const sourceAllLeads = allCampaignLeads || leads;
  const allSelected = leads.length > 0 && selected.size === leads.length;
  const selectedLeads = sourceAllLeads.filter((lead) => selected.has(lead.id));
  const selectedWithDrafts = selectedLeads.filter((lead) => hasVerifiedDraft(lead) && !isAlreadySent(lead));
  const selectedMissingRequired = selectedLeads.length - selectedWithDrafts.length;
  const allWithDrafts = sourceAllLeads.filter((lead) => hasVerifiedDraft(lead) && !isAlreadySent(lead));
  const allMissingRequired = sourceAllLeads.length - allWithDrafts.length;
  const bulkTargets = bulkMode === "selected" ? selectedWithDrafts : allWithDrafts;
  const bulkVisibleTargets = bulkTargets.filter((lead) => !bulkSentLeadIds.has(lead.id));
  const bulkMissingCount = bulkMode === "selected" ? selectedMissingRequired : allMissingRequired;
  const bulkStopRequestedRef = useRef(false);

  function showToast(type: "success" | "error", message: string) {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3500);
  }

  async function loadAllCampaignLeads() {
    setLoadingAllLeads(true);
    setAllLeadsError(null);
    try {
      // Persist matched draft data into DB first so bulk send uses real lead records.
      await fetch(`/api/outreach/sync-drafts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId }),
      });

      const [resLeads, resMerge] = await Promise.all([
        fetch(`/api/outreach/${campaignId}/leads`),
        fetch(`/api/outreach/sync-drafts?debug=1&campaignId=${campaignId}&limit=2000&includeDraftData=1`),
      ]);
      const leadsData = await resLeads.json().catch(() => []);
      const mergeData = await resMerge.json().catch(() => null);

      if (!resLeads.ok || !Array.isArray(leadsData)) {
        setAllLeadsError("Failed to load full campaign leads.");
        setAllCampaignLeads(null);
        return;
      }

      const mergedById = new Map<
        string,
        { effectiveEmail?: string; effectiveEmails?: string[]; effectiveTemplate?: string; effectiveSubject?: string }
      >();
      if (resMerge.ok && mergeData?.mergedLeads && Array.isArray(mergeData.mergedLeads)) {
        for (const row of mergeData.mergedLeads) {
          if (!row?.leadId) continue;
          mergedById.set(row.leadId, {
            effectiveEmail: row.effectiveEmail || "",
            effectiveEmails: Array.isArray(row.effectiveEmails) ? row.effectiveEmails : [],
            effectiveTemplate: row.effectiveTemplate || "",
            effectiveSubject: row.effectiveSubject || "",
          });
        }
      }

      const mergedLeads = (leadsData as Lead[]).map((lead) => {
        const m = mergedById.get(lead.id);
        if (!m) return lead;
        const nextNotes = m.effectiveSubject
          ? upsertSubjectInLocalNotes(lead.notes, m.effectiveSubject)
          : lead.notes;
        return {
          ...lead,
          emailAddress: m.effectiveEmail || lead.emailAddress,
          sendToEmails: (m.effectiveEmails || []).length
            ? m.effectiveEmails
            : m.effectiveEmail
              ? [m.effectiveEmail]
              : lead.emailAddress
                ? [lead.emailAddress]
                : [],
          emailTemplate: m.effectiveTemplate || lead.emailTemplate,
          notes: nextNotes,
        };
      });

      setAllCampaignLeads(mergedLeads);
    } catch {
      setAllLeadsError("Failed to load full campaign leads.");
      setAllCampaignLeads(null);
    } finally {
      setLoadingAllLeads(false);
    }
  }

  function enterSelectMode() {
    setSelectMode(true);
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelected(new Set());
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(leads.map((l) => l.id)));
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function updateStatus(leadId: string, emailStatus: string) {
    const scrollY = window.scrollY;
    const data: Record<string, unknown> = { emailStatus };
    if (emailStatus === "sent") {
      data.emailSentAt = new Date().toISOString();
    }
    await fetch(`/api/outreach/${campaignId}/leads/${leadId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    router.refresh();
    requestAnimationFrame(() => window.scrollTo(0, scrollY));
  }

  async function bulkUpdateStatus(status: string) {
    setUpdating(true);
    await Promise.all(
      Array.from(selected).map((id) => updateStatus(id, status))
    );
    setSelected(new Set());
    setSelectMode(false);
    setUpdating(false);
    router.refresh();
  }

  async function handleBulkDelete() {
    setUpdating(true);
    await Promise.all(
      Array.from(selected).map((id) =>
        fetch(`/api/outreach/${campaignId}/leads/${id}`, { method: "DELETE" })
      )
    );
    setSelected(new Set());
    setSelectMode(false);
    setShowDeleteModal(false);
    setUpdating(false);
    router.refresh();
  }

  function requestStopBulkSend() {
    if (!bulkSending || bulkStopping) return;
    bulkStopRequestedRef.current = true;
    setBulkStopping(true);
    setBulkResult("Stopping after current email...");
  }

  async function startBulkSendRun(requestedCount: number) {
    if (bulkSending) return;
    const targetSnapshot = [...bulkTargets];
    const sendQueue = targetSnapshot.slice(0, Math.max(0, requestedCount));
    const missingCountSnapshot = bulkMissingCount;
    const totalAvailableSnapshot = targetSnapshot.length;
    const modeSnapshot = bulkMode;

    bulkStopRequestedRef.current = false;
    setBulkStopping(false);
    setBulkRunMode(modeSnapshot);
    setBulkRunRequestedCount(sendQueue.length);
    setBulkSending(true);
    setBulkResult(null);
    setBulkProgress({ done: 0, total: sendQueue.length });
    setBulkSentLeadIds(new Set());
    setBulkCooldownSeconds(null);

    let sent = 0;
    let failed = 0;
    let done = 0;
    let blockedByPolicy = false;

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));

    function getRandomDelayMs() {
      // Keep at least 45s and vary timing to avoid fixed automation cadence.
      const min = 45_000;
      const max = 75_000;
      return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    async function runCooldown(delayMs: number) {
      let remaining = Math.ceil(delayMs / 1000);
      setBulkCooldownSeconds(remaining);
      while (remaining > 0) {
        if (bulkStopRequestedRef.current) {
          setBulkCooldownSeconds(null);
          return;
        }
        await sleep(1000);
        remaining -= 1;
        setBulkCooldownSeconds(remaining > 0 ? remaining : null);
      }
    }

    async function sendOne(lead: Lead) {
      const renderedSubject = getLeadSubject(lead);
      if (!renderedSubject) {
        failed += 1;
        done += 1;
        setBulkProgress({ done, total: sendQueue.length });
        return { policyBlocked: false };
      }
      if (isAlreadySent(lead)) {
        done += 1;
        setBulkProgress({ done, total: sendQueue.length });
        return { policyBlocked: false };
      }
      const text = lead.emailTemplate?.trim();
      if (!text) {
        failed += 1;
        done += 1;
        setBulkProgress({ done, total: sendQueue.length });
        return { policyBlocked: false };
      }
      const recipients = (lead.sendToEmails || [])
        .map((e) => e?.trim())
        .filter((e): e is string => Boolean(e));
      const primaryTo = recipients[0] || lead.emailAddress?.trim() || "";
      if (!primaryTo) {
        failed += 1;
        done += 1;
        setBulkProgress({ done, total: sendQueue.length });
        return { policyBlocked: false };
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);
      try {
        const res = await fetch(`/api/outreach/${campaignId}/leads/${lead.id}/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: recipients.length ? recipients : [primaryTo],
            primaryTo,
            subject: renderedSubject,
            text,
          }),
          signal: controller.signal,
        });
        const payload = await res.json().catch(() => ({}));
        if (res.ok) {
          sent += 1;
          setBulkSentLeadIds((prev) => {
            const next = new Set(prev);
            next.add(lead.id);
            return next;
          });
          return { policyBlocked: false };
        }
        failed += 1;
        const errMsg = String(payload?.error || "");
        if (errMsg.includes("550 5.4.6")) {
          return { policyBlocked: true };
        }
        return { policyBlocked: false };
      } catch {
        failed += 1;
        return { policyBlocked: false };
      } finally {
        clearTimeout(timeout);
        done += 1;
        setBulkProgress({ done, total: sendQueue.length });
      }
    }

    for (let i = 0; i < sendQueue.length; i += 1) {
      if (bulkStopRequestedRef.current) break;
      const lead = sendQueue[i];
      const outcome = await sendOne(lead);
      if (outcome.policyBlocked) {
        blockedByPolicy = true;
        break;
      }
      if (bulkStopRequestedRef.current) break;
      if (i < sendQueue.length - 1) {
        const delayMs = getRandomDelayMs();
        await runCooldown(delayMs);
      }
    }

    setBulkSending(false);
    setBulkStopping(false);
    setBulkCooldownSeconds(null);
    const deferred = Math.max(0, totalAvailableSnapshot - sendQueue.length);
    const unsentInBatch = Math.max(0, sendQueue.length - done);
    const stoppedByUser = bulkStopRequestedRef.current;
    const completionMessage = blockedByPolicy
      ? `Stopped by Zoho policy signal (550 5.4.6). ${sent} sent, ${failed} failed, ${unsentInBatch} unsent in this batch, ${missingCountSnapshot} skipped, ${deferred} deferred for later.`
      : stoppedByUser
        ? `Stopped by user. ${sent} sent, ${failed} failed, ${unsentInBatch} unsent in this batch, ${missingCountSnapshot} skipped, ${deferred} deferred for later.`
        : `Bulk send complete: ${sent} sent, ${failed} failed, ${missingCountSnapshot} skipped (missing email/template), ${deferred} deferred for later.`;
    setBulkResult(completionMessage);
    showToast(failed > 0 ? "error" : "success", completionMessage);
    setBulkProgress(null);
    router.refresh();
  }

  return (
    <>
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        {!selectMode ? (
          <>
            <button
              onClick={enterSelectMode}
              className="text-xs font-medium text-text-muted hover:text-text px-3 py-1.5 rounded-lg border border-border hover:bg-surface-overlay transition-colors"
            >
              Select
            </button>
            <button
              onClick={async () => {
                setShowDebugModal(true);
                setDebugLoading(true);
                const res = await fetch(`/api/outreach/sync-drafts?debug=1&campaignId=${campaignId}&limit=500`);
                const data = await res.json().catch(() => null);
                if (data?.ok) setDebugData(data);
                else setDebugData(null);
                setDebugLoading(false);
              }}
              className="border border-border hover:bg-surface-overlay text-text px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
            >
              Debug Match
            </button>
            <button
              onClick={async () => {
                setBulkMode("all");
                setBulkResult(null);
                setBulkSentLeadIds(new Set());
                setShowBulkSendModal(true);
                await loadAllCampaignLeads();
              }}
              disabled={bulkSending}
              className="bg-primary hover:bg-primary-dark text-white px-3 py-1 rounded-full text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Bulk Send
            </button>
          </>
        ) : (
          <>
            <button
              onClick={exitSelectMode}
              className="text-xs font-medium text-text-muted hover:text-text px-3 py-1.5 rounded-lg border border-border hover:bg-surface-overlay transition-colors"
            >
              Cancel
            </button>
            {selected.size > 0 && (
              <>
                <span className="text-xs text-text-muted">
                  {selected.size} selected:
                </span>
                {EMAIL_STATUSES.map((s) => (
                  <button
                    key={s}
                    onClick={() => bulkUpdateStatus(s)}
                    disabled={updating}
                    className={`text-xs font-medium px-2.5 py-1 rounded-full transition-colors disabled:opacity-50 ${STATUS_COLORS[s]} hover:opacity-80`}
                  >
                    {STATUS_LABELS[s]}
                  </button>
                ))}
                <button
                  onClick={() => setShowDeleteModal(true)}
                  disabled={updating}
                  className="bg-red-600 hover:bg-red-700 text-white px-3 py-1 rounded-full text-xs font-medium transition-colors disabled:opacity-50"
                >
                  Delete
                </button>
                <button
                  onClick={async () => {
                    setBulkMode("selected");
                    setBulkResult(null);
                    setBulkSentLeadIds(new Set());
                    setShowBulkSendModal(true);
                    await loadAllCampaignLeads();
                  }}
                  disabled={updating || bulkSending}
                  className="bg-primary hover:bg-primary-dark text-white px-3 py-1 rounded-full text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Bulk Send
                </button>
              </>
            )}
          </>
        )}
      </div>
      {bulkSending || bulkStopping ? (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2">
          <p className="text-xs text-text">
            Bulk send running in background ({bulkRunMode === "selected" ? "selected" : "all"} scope)
            {bulkProgress ? `: ${bulkProgress.done}/${bulkProgress.total}` : ""}
            {bulkCooldownSeconds !== null ? ` · next send in ${bulkCooldownSeconds}s` : ""}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowBulkSendModal(true)}
              className="rounded border border-border px-2 py-1 text-xs text-text-muted hover:text-text"
            >
              Open details
            </button>
            <button
              onClick={requestStopBulkSend}
              disabled={bulkStopping}
              className="rounded border border-red-500/50 px-2 py-1 text-xs text-red-300 hover:text-red-200 disabled:opacity-50"
            >
              {bulkStopping ? "Stopping..." : "Stop"}
            </button>
          </div>
        </div>
      ) : null}

      <div className="bg-surface-raised rounded-xl border border-border overflow-hidden">
        {leads.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-text-faint">No leads in this campaign</p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-surface-overlay">
                {selectMode && (
                  <th className="px-4 py-3 w-10">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      className="rounded border-border accent-primary"
                    />
                  </th>
                )}
                <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wider px-4 py-3">
                  Business
                </th>
                <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wider px-4 py-3">
                  Website
                </th>
                <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wider px-4 py-3">
                  Email
                </th>
                <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wider px-4 py-3">
                  Phone
                </th>
                <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wider px-4 py-3">
                  Status
                </th>
                <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wider px-4 py-3">
                  Sent At
                </th>
                <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wider px-4 py-3">
                  Follow-ups
                </th>
                <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wider px-4 py-3">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {leads.map((lead) => (
                <tr
                  key={lead.id}
                  className={`hover:bg-surface-overlay transition-colors ${selectMode && selected.has(lead.id) ? "bg-primary/5" : ""}`}
                >
                  {selectMode && (
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(lead.id)}
                        onChange={() => toggleOne(lead.id)}
                        className="rounded border-border accent-primary"
                      />
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <p className="font-medium text-sm text-text">
                      {lead.businessName}
                    </p>
                    {lead.address && (
                      <p className="text-text-faint text-xs">{lead.address}</p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {lead.website ? (
                      <a
                        href={lead.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary text-xs hover:underline truncate block max-w-48"
                      >
                        {lead.website.replace(/^https?:\/\//, "")}
                      </a>
                    ) : (
                      <span className="text-text-faint text-xs">--</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <EditableEmail
                      leadId={lead.id}
                      campaignId={campaignId}
                      value={lead.emailAddress}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <EditableField
                      leadId={lead.id}
                      campaignId={campaignId}
                      field="phone"
                      value={lead.phone}
                      placeholder="Add phone..."
                      type="tel"
                      label="Phone Number"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <StatusDropdown
                      value={lead.emailStatus}
                      onChange={(status) => updateStatus(lead.id, status)}
                    />
                  </td>
                  <td className="px-4 py-3 text-xs text-text-muted">
                    {lead.emailSentAt
                      ? new Date(lead.emailSentAt).toLocaleString()
                      : "--"}
                  </td>
                  <td className="px-4 py-3 text-xs text-text-muted">
                    {lead.followUpCount}
                  </td>
                  <td className="px-4 py-3">
                    <SendEmailButton
                      leadId={lead.id}
                      campaignId={campaignId}
                      businessName={lead.businessName}
                      emailAddress={lead.emailAddress}
                      emailTemplate={lead.emailTemplate}
                      notes={lead.notes}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <ConfirmModal
        open={showDeleteModal}
        title="Delete Selected Leads"
        message={`This will permanently delete ${selected.size} selected lead${selected.size !== 1 ? "s" : ""}. This action cannot be undone.`}
        confirmLabel={`Delete ${selected.size}`}
        loading={updating}
        onConfirm={handleBulkDelete}
        onCancel={() => setShowDeleteModal(false)}
      />
      {showBulkSendModal ? (
        <BulkSendModal
          mode={bulkMode}
          selectedCount={selected.size}
          sendableCount={bulkTargets.length}
          missingEmailsCount={bulkMissingCount}
          totalScopeCount={bulkMode === "selected" ? selectedLeads.length : sourceAllLeads.length}
          leads={bulkVisibleTargets}
          loading={bulkSending}
          loadingAllLeads={loadingAllLeads}
          allLeadsError={allLeadsError}
          result={bulkResult}
          onCancel={() => setShowBulkSendModal(false)}
          onSend={startBulkSendRun}
          progress={bulkProgress}
          cooldownSeconds={bulkCooldownSeconds}
          onStop={requestStopBulkSend}
          stopLoading={bulkStopping}
          runRequestedCount={bulkRunRequestedCount}
        />
      ) : null}

      {showDebugModal ? (
        <div className="fixed inset-0 z-50 bg-black/60 p-4">
          <div className="mx-auto mt-4 flex h-[88vh] w-full max-w-6xl flex-col rounded-xl border border-border bg-surface-raised">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold text-text">Website Match Debug</h3>
              <button
                onClick={() => setShowDebugModal(false)}
                className="rounded border border-border px-2 py-1 text-xs text-text-muted hover:text-text"
              >
                Close
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {debugLoading ? (
                <p className="text-sm text-text-muted">Loading debug data...</p>
              ) : !debugData ? (
                <p className="text-sm text-red-400">Failed to load debug data.</p>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs text-text-faint">
                    Checked: {debugData.dbLeadsChecked} · Matched: {debugData.matched} · Unmatched: {debugData.unmatched}
                  </p>
                  <div className="rounded-lg border border-border overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-surface-overlay border-b border-border">
                        <tr>
                          <th className="px-2 py-2 text-left">Business</th>
                          <th className="px-2 py-2 text-left">DB Website</th>
                          <th className="px-2 py-2 text-left">Normalized Key</th>
                          <th className="px-2 py-2 text-left">Draft Website</th>
                          <th className="px-2 py-2 text-left">Match</th>
                          <th className="px-2 py-2 text-left">DB Ready</th>
                        </tr>
                      </thead>
                      <tbody>
                        {debugData.debugSamples.map((row, idx) => (
                          <tr key={`${row.normalizedDbKey}-${idx}`} className="border-b border-border">
                            <td className="px-2 py-2">{row.businessName}</td>
                            <td className="px-2 py-2 break-all">{row.dbWebsite || "--"}</td>
                            <td className="px-2 py-2 break-all">{row.normalizedDbKey}</td>
                            <td className="px-2 py-2 break-all">{row.draftWebsite || "--"}</td>
                            <td className="px-2 py-2">{row.matched ? "Yes" : "No"}</td>
                            <td className="px-2 py-2">
                              {row.dbHasEmail && row.dbHasTemplate && row.dbHasSubject ? "Ready" : "Missing data"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
      {toast ? (
        <div className="fixed right-4 top-4 z-[60]">
          <div
            className={`rounded-lg border px-4 py-3 text-sm shadow-lg ${
              toast.type === "success"
                ? "border-green-500/40 bg-green-500/15 text-green-200"
                : "border-red-500/40 bg-red-500/15 text-red-200"
            }`}
          >
            {toast.message}
          </div>
        </div>
      ) : null}
    </>
  );
}

function getLeadSubject(lead: Lead) {
  const match = (lead.notes || "").match(/OUTREACH_SUBJECT::([^\n]+)/);
  return match?.[1]?.trim() || "";
}

function upsertSubjectInLocalNotes(notes: string | null, subject: string) {
  const marker = "OUTREACH_SUBJECT::";
  const existing = notes || "";
  if (existing.includes(marker)) {
    return existing.replace(/OUTREACH_SUBJECT::[^\n]*/g, `${marker}${subject}`);
  }
  return existing ? `${existing}\n${marker}${subject}` : `${marker}${subject}`;
}

function hasVerifiedDraft(lead: Lead) {
  return Boolean(
    lead.emailAddress?.trim() &&
      lead.emailTemplate?.trim() &&
      getLeadSubject(lead)
  );
}

function isAlreadySent(lead: Lead) {
  return String(lead.emailStatus || "").toLowerCase() === "sent";
}

function BulkSendModal({
  mode,
  selectedCount,
  sendableCount,
  missingEmailsCount,
  totalScopeCount,
  leads,
  loading,
  loadingAllLeads,
  allLeadsError,
  result,
  progress,
  cooldownSeconds,
  onCancel,
  onSend,
  onStop,
  stopLoading,
  runRequestedCount,
}: {
  mode: "selected" | "all";
  selectedCount: number;
  sendableCount: number;
  missingEmailsCount: number;
  totalScopeCount: number;
  leads: Lead[];
  loading: boolean;
  loadingAllLeads: boolean;
  allLeadsError: string | null;
  result: string | null;
  progress: { done: number; total: number } | null;
  cooldownSeconds: number | null;
  onCancel: () => void;
  onSend: (requestedCount: number) => void;
  onStop: () => void;
  stopLoading: boolean;
  runRequestedCount: number;
}) {
  const [activeLeadId, setActiveLeadId] = useState<string | null>(leads[0]?.id || null);
  const [confirmReady, setConfirmReady] = useState(false);
  const [sendStrategy, setSendStrategy] = useState<"all" | "count">("all");
  const [sendCountInput, setSendCountInput] = useState("50");
  const activeLead = leads.find((lead) => lead.id === activeLeadId) || leads[0] || null;
  const previewSubject = activeLead ? getLeadSubject(activeLead) : "";
  const previewBody = activeLead?.emailTemplate?.trim() || "";
  const activeRecipients = (activeLead?.sendToEmails || [])
    .map((e) => e?.trim())
    .filter((e): e is string => Boolean(e));
  const parsedRequestedCount = Number.parseInt(sendCountInput || "0", 10);
  const requestedCount =
    sendStrategy === "all"
      ? sendableCount
      : Math.min(
          sendableCount,
          Number.isNaN(parsedRequestedCount) ? 0 : Math.max(0, parsedRequestedCount)
        );
  const sendDisabledReason =
    loading
      ? "Sending in progress"
      : loadingAllLeads
        ? "Still loading campaign leads"
        : requestedCount === 0
          ? "Set a send count greater than 0"
          : !confirmReady
            ? "Tick the confirmation checkbox first"
            : null;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 p-4">
      <div className="mx-auto mt-2 flex h-[92vh] w-full max-w-6xl flex-col rounded-xl border border-border bg-surface-raised">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold text-text">Bulk Send Emails</h3>
          <button
            onClick={onCancel}
            className="rounded border border-border px-2 py-1 text-xs text-text-muted hover:text-text"
          >
            Close
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <p className="text-xs text-text-faint">
            Scope: {mode === "selected" ? "Selected rows" : "All campaign leads (no pagination)"} · Selected: {selectedCount} · In scope: {totalScopeCount} · Sendable: {sendableCount} · Missing required data: {missingEmailsCount}
          </p>
          {mode === "all" && loadingAllLeads ? (
            <p className="text-xs text-primary">Loading full campaign leads...</p>
          ) : null}
          {allLeadsError ? (
            <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {allLeadsError}
            </p>
          ) : null}
          {sendableCount === 0 ? (
            <p className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-300">
              No sendable leads in this scope yet. Leads need both email address and verified custom email body.
            </p>
          ) : null}
          {sendableCount > 0 ? (
            <div className="rounded-md border border-border bg-surface p-3 space-y-2">
              <p className="text-xs text-text-faint">
                Send strategy: always starts from the remaining unsent sendable leads in this scope.
              </p>
              <div className="flex items-center gap-3 flex-wrap">
                <label className="flex items-center gap-2 text-xs text-text">
                  <input
                    type="radio"
                    checked={sendStrategy === "all"}
                    onChange={() => setSendStrategy("all")}
                    className="accent-primary"
                  />
                  Send all ({sendableCount})
                </label>
                <label className="flex items-center gap-2 text-xs text-text">
                  <input
                    type="radio"
                    checked={sendStrategy === "count"}
                    onChange={() => setSendStrategy("count")}
                    className="accent-primary"
                  />
                  Send next
                </label>
                <input
                  type="number"
                  min={1}
                  max={sendableCount}
                  value={sendCountInput}
                  onChange={(e) => setSendCountInput(e.target.value)}
                  disabled={sendStrategy !== "count"}
                  className="w-24 rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-text outline-none focus:border-primary disabled:opacity-40"
                />
                <span className="text-xs text-text-faint">
                  Planned this run: <span className="text-text">{requestedCount}</span>
                </span>
              </div>
            </div>
          ) : null}

          <div className="grid gap-3 lg:grid-cols-[320px,1fr]">
            <div className="rounded-lg border border-border bg-surface p-2 max-h-[62vh] overflow-y-auto space-y-1">
              {leads.map((lead, index) => {
                const isActive = lead.id === activeLead?.id;
                const leadSubject = getLeadSubject(lead);
                return (
                  <button
                    type="button"
                    key={lead.id}
                    onClick={() => setActiveLeadId(lead.id)}
                    className={`w-full text-left rounded-md border px-2 py-2 transition-colors ${
                      isActive ? "border-primary/60 bg-primary/10" : "border-border hover:bg-surface-overlay"
                    }`}
                  >
                    <p className="text-[11px] text-text-faint">#{index + 1}</p>
                    <p className="text-xs font-medium text-text truncate">{lead.businessName}</p>
                    <p className="text-[11px] text-text-faint truncate">{lead.emailAddress}</p>
                    <p className="text-[11px] text-primary/90 truncate">
                      {(() => {
                        const recipientCount = (lead.sendToEmails || []).filter((e) => Boolean(e?.trim())).length;
                        return `${recipientCount} recipient${recipientCount === 1 ? "" : "s"}`;
                      })()}
                    </p>
                    <p className="text-[11px] text-text-muted truncate mt-1">{leadSubject}</p>
                  </button>
                );
              })}
              {leads.length === 0 ? (
                <p className="text-xs text-text-faint p-2">No sendable leads in current scope.</p>
              ) : null}
            </div>

            <div className="space-y-2">
              <div className="rounded-lg border border-border bg-surface p-3 space-y-2">
                <p className="text-xs text-text-faint">
                  Preview for: <span className="text-text">{activeLead?.businessName || "--"}</span>
                </p>
                <p className="text-xs text-text-faint">
                  Recipients:{" "}
                  <span className="text-text">
                    {activeRecipients.length
                      ? activeRecipients.join(", ")
                      : activeLead?.emailAddress || "--"}
                  </span>
                </p>
                <p className="text-sm font-medium text-text">{previewSubject}</p>
                <pre className="text-xs leading-5 whitespace-pre-wrap rounded-md border border-border bg-surface-2 p-3 max-h-[30vh] overflow-y-auto text-text">
                  {previewBody}
                </pre>
              </div>
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={confirmReady}
              onChange={(e) => setConfirmReady(e.target.checked)}
              className="rounded border-border accent-primary"
            />
            I confirmed the preview and want to send to {requestedCount} recipients.
          </label>

          {result ? <p className="text-xs text-green-400">{result}</p> : null}
          {loading && progress ? (
            <p className="text-xs text-primary">
              Sending... {progress.done}/{progress.total} · Remaining:{" "}
              {Math.max(0, progress.total - progress.done)}
            </p>
          ) : null}
          {loading ? (
            <p className="text-xs text-text-faint">
              You can close this modal. Sending will continue in the background.
            </p>
          ) : null}
          {loading && cooldownSeconds !== null ? (
            <p className="text-xs text-primary">
              Waiting before next send: {cooldownSeconds}s
            </p>
          ) : null}
          {sendDisabledReason ? (
            <p className="text-xs text-yellow-300">{sendDisabledReason}</p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            onClick={onCancel}
            className="rounded-lg border border-border px-3 py-2 text-xs text-text-muted hover:text-text"
          >
            {loading ? "Close (keep running)" : "Cancel"}
          </button>
          {loading ? (
            <button
              onClick={onStop}
              disabled={stopLoading}
              className="rounded-lg border border-red-500/50 px-3 py-2 text-xs font-medium text-red-300 hover:text-red-200 disabled:opacity-50"
            >
              {stopLoading ? "Stopping..." : "Stop Sending"}
            </button>
          ) : null}
          <button
            onClick={() => onSend(requestedCount)}
            disabled={Boolean(sendDisabledReason)}
            title={sendDisabledReason || `Send ${requestedCount} emails now`}
            className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-white hover:bg-primary-dark disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? `Sending ${runRequestedCount || requestedCount}...` : `Send ${requestedCount} Emails`}
          </button>
        </div>
      </div>
    </div>
  );
}

function SendEmailButton({
  leadId,
  campaignId,
  businessName,
  emailAddress,
  emailTemplate,
  notes,
}: {
  leadId: string;
  campaignId: string;
  businessName: string;
  emailAddress: string | null;
  emailTemplate: string | null;
  notes: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(emailAddress || "");
  const [subject, setSubject] = useState((notes || "").match(/OUTREACH_SUBJECT::([^\n]+)/)?.[1]?.trim() || "");
  const [body, setBody] = useState(emailTemplate || "");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSend() {
    setSending(true);
    setError(null);
    const res = await fetch(`/api/outreach/${campaignId}/leads/${leadId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: to.trim(),
        subject: subject.trim(),
        text: body,
      }),
    });
    const data = await res.json().catch(() => ({}));
    setSending(false);

    if (!res.ok) {
      setError(data?.error || "Failed to send email");
      return;
    }

    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        disabled={!emailAddress || !emailTemplate?.trim() || !subject.trim()}
        className="rounded-md border border-border px-2.5 py-1 text-xs text-text hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40"
        title={
          !emailAddress
            ? "Add email address first"
            : !emailTemplate?.trim()
              ? "No verified custom email body for this lead"
              : !subject.trim()
                ? "No verified email subject for this lead"
                : "Send outreach email"
        }
      >
        Send
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 bg-black/60 p-4">
          <div className="mx-auto mt-8 w-full max-w-2xl rounded-xl border border-border bg-surface-raised p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-text">Send Email</h3>
              <button
                onClick={() => setOpen(false)}
                className="rounded border border-border px-2 py-1 text-xs text-text-muted hover:text-text"
              >
                Close
              </button>
            </div>

            <p className="text-xs text-text-faint">{businessName}</p>

            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="Recipient email"
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary"
            />
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary"
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={14}
              placeholder="Email body"
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary"
            />

            {error ? <p className="text-xs text-red-400">{error}</p> : null}

            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                className="rounded-lg border border-border px-3 py-2 text-xs text-text-muted hover:text-text"
              >
                Cancel
              </button>
              <button
                onClick={handleSend}
                disabled={sending || !to.trim() || !subject.trim() || !body.trim()}
                className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-white hover:bg-primary-dark disabled:opacity-40"
              >
                {sending ? "Sending..." : "Send Email"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function StatusDropdown({
  value,
  onChange,
}: {
  value: string;
  onChange: (status: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, dropUp: false });
  const btnRef = useRef<HTMLButtonElement>(null);

  function handleOpen() {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const dropUp = spaceBelow < 200;
      setPos({
        top: dropUp ? rect.top : rect.bottom + 4,
        left: rect.left,
        dropUp,
      });
    }
    setOpen(!open);
  }

  return (
    <>
      <button
        ref={btnRef}
        onClick={handleOpen}
        className={`text-xs font-medium px-2.5 py-1 rounded-full cursor-pointer ${STATUS_COLORS[value] || ""}`}
      >
        {STATUS_LABELS[value] || value}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="fixed z-50 bg-surface-raised border border-border rounded-lg shadow-lg py-1 min-w-36"
            style={{
              left: pos.left,
              ...(pos.dropUp
                ? { bottom: window.innerHeight - pos.top + 4 }
                : { top: pos.top }),
            }}
          >
            {EMAIL_STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => {
                  onChange(s);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-1.5 text-xs font-medium hover:bg-surface-overlay transition-colors flex items-center gap-2 ${
                  s === value ? "text-primary" : "text-text-muted"
                }`}
              >
                <span
                  className={`w-2 h-2 rounded-full ${STATUS_COLORS[s]?.split(" ")[0] || "bg-white/10"}`}
                />
                {STATUS_LABELS[s]}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function EditableEmail({
  leadId,
  campaignId,
  value,
}: {
  leadId: string;
  campaignId: string;
  value: string | null;
}) {
  return (
    <EditableField
      leadId={leadId}
      campaignId={campaignId}
      field="emailAddress"
      value={value}
      placeholder="Add email..."
      type="email"
      label="Email Address"
    />
  );
}

function EditableField({
  leadId,
  campaignId,
  field,
  value,
  placeholder,
  type = "text",
  label,
}: {
  leadId: string;
  campaignId: string;
  field: string;
  value: string | null;
  placeholder: string;
  type?: string;
  label?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  async function save(newValue: string) {
    setSaving(true);
    const scrollY = window.scrollY;
    await fetch(`/api/outreach/${campaignId}/leads/${leadId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: newValue || null }),
    });
    setSaving(false);
    setOpen(false);
    router.refresh();
    requestAnimationFrame(() => window.scrollTo(0, scrollY));
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-xs text-text-muted hover:text-text truncate block max-w-40"
      >
        {value || placeholder}
      </button>
      <EditFieldModal
        open={open}
        title={label || `Edit ${field}`}
        value={value || ""}
        placeholder={placeholder}
        type={field === "notes" ? "textarea" : type}
        loading={saving}
        onSave={save}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}
