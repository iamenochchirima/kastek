"use client";

import { useState } from "react";
import { buttonClassName } from "@/components/ui/button";
import ConfirmModal from "@/components/admin/confirm-modal";

type Command = { id: string; status: string; requiredApprovals: number; approvers: string[]; result?: { status?: string } | null; error?: { message?: string } | null };

export function OperatorInstallationButton({ installationId, action, expectedOrganizationId }: { installationId: string; action: "suspend" | "resume"; expectedOrganizationId?: string }) {
  const [command, setCommand] = useState<Command | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const commandType = action === "suspend" ? "suspend_installation" : "resume_installation";

  async function start() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/operations/commands", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `admin-${commandType}-${installationId}-${Date.now()}` },
        body: JSON.stringify({ commandType, targetId: installationId, payload: expectedOrganizationId ? { expectedOrganizationId } : {} }),
      });
      const data = await response.json() as Command & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Unable to create operator command");
      setCommand(data);
      setMessage(data.status === "awaiting_approval" ? "Second operator approval required." : "Installation command accepted.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to create operator command");
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!command) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/operations/commands/${encodeURIComponent(command.id)}/approve`, { method: "POST" });
      const data = await response.json() as Command & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Unable to approve operator command");
      setCommand(data);
      setMessage("Installation command completed.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to approve operator command");
    } finally {
      setBusy(false);
    }
  }

  return <div className="flex flex-col items-end gap-1"><button type="button" disabled={busy || Boolean(command && command.status !== "failed")} onClick={() => void start()} className={buttonClassName({ variant: "ghost", size: "sm" })}>{busy ? "Submitting…" : action === "suspend" ? "Suspend" : "Resume"}</button>{command?.status === "awaiting_approval" ? <button type="button" disabled={busy} onClick={() => void approve()} className={buttonClassName({ variant: "secondary", size: "sm" })}>{busy ? "Approving…" : "Approve"}</button> : null}{message ? <span className="max-w-48 text-right text-[11px] text-muted-foreground">{message}</span> : null}</div>;
}

export function OperatorReconcileButton({ effectId, expectedOrganizationId, expectedInstallationId }: { effectId: string; expectedOrganizationId?: string; expectedInstallationId?: string }) {
  const [command, setCommand] = useState<Command | null>(null);
  const [outcome, setOutcome] = useState<"succeeded" | "failed">("failed");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/operations/commands", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `admin-reconcile-${effectId}-${Date.now()}` },
        body: JSON.stringify({ commandType: "reconcile_effect", targetId: effectId, payload: { ...(expectedOrganizationId ? { expectedOrganizationId } : {}), ...(expectedInstallationId ? { expectedInstallationId } : {}), ...(outcome === "failed" ? { outcome, error: { code: "OPERATOR_CONFIRMED_FAILURE" } } : { outcome }) } }),
      });
      const data = await response.json() as Command & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Unable to create operator command");
      setCommand(data);
      setMessage(data.status === "awaiting_approval" ? "Second operator approval required." : "Reconciliation command accepted.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to create operator command");
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!command) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/operations/commands/${encodeURIComponent(command.id)}/approve`, { method: "POST" });
      const data = await response.json() as Command & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Unable to approve operator command");
      setCommand(data);
      setMessage("Reconciliation command completed.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to approve operator command");
    } finally {
      setBusy(false);
    }
  }

  return <div className="flex flex-col items-end gap-1.5">
    {!command || command.status === "failed" ? <div className="flex items-center gap-2">
      <label className="sr-only" htmlFor={`reconcile-outcome-${effectId}`}>Reconciliation outcome</label>
      <select id={`reconcile-outcome-${effectId}`} value={outcome} onChange={(event) => setOutcome(event.target.value as "succeeded" | "failed")} disabled={busy} className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground">
        <option value="failed">Provider failed</option>
        <option value="succeeded">Provider succeeded</option>
      </select>
      <button type="button" disabled={busy} onClick={() => void start()} className={buttonClassName({ variant: "secondary", size: "sm" })}>{busy ? "Submitting…" : "Request resolution"}</button>
    </div> : null}
    {command?.status === "awaiting_approval" ? <button type="button" disabled={busy} onClick={() => void approve()} className={buttonClassName({ variant: "secondary", size: "sm" })}>{busy ? "Approving…" : "Approve as second operator"}</button> : null}
    {message ? <span className="max-w-56 text-right text-[11px] text-muted-foreground">{message}</span> : null}
  </div>;
}

function OperatorRecoveryCommandButton({ commandType, targetId, label, completedMessage, payload = {}, confirmMessage }: {
  commandType: "cancel_run" | "retry_run" | "replay_delivery" | "delete_memory" | "request_export" | "kill_switch_disable" | "release_hold" | "apply_retention_policy" | "release_legal_hold";
  targetId: string;
  label: string;
  completedMessage: string;
  payload?: Record<string, unknown>;
  confirmMessage?: string;
}) {
  const [command, setCommand] = useState<Command | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function start() {
    setConfirming(false);
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/operations/commands", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `admin-${commandType}-${targetId}-${Date.now()}` },
        body: JSON.stringify({ commandType, targetId, payload }),
      });
      const data = await response.json() as Command & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Unable to create operator command");
      setCommand(data);
      setMessage(data.status === "awaiting_approval" ? "Second operator approval required." : completedMessage);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to create operator command");
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!command) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/operations/commands/${encodeURIComponent(command.id)}/approve`, { method: "POST" });
      const data = await response.json() as Command & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Unable to approve operator command");
      setCommand(data);
      setMessage(completedMessage);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to approve operator command");
    } finally {
      setBusy(false);
    }
  }

  return <div className="flex flex-col items-end gap-1">
    {!command || command.status === "failed" ? <button type="button" disabled={busy} onClick={() => confirmMessage ? setConfirming(true) : void start()} className={buttonClassName({ variant: "secondary", size: "sm" })}>{busy ? "Submitting…" : label}</button> : null}
    {command?.status === "awaiting_approval" ? <button type="button" disabled={busy} onClick={() => void approve()} className={buttonClassName({ variant: "secondary", size: "sm" })}>{busy ? "Approving…" : "Approve as second operator"}</button> : null}
    {message ? <span className="max-w-56 text-right text-[11px] text-muted-foreground">{message}</span> : null}
    {confirmMessage ? <ConfirmModal open={confirming} title="Confirm operator action?" message={confirmMessage} confirmLabel="Continue" loading={busy} onConfirm={() => void start()} onCancel={() => setConfirming(false)} /> : null}
  </div>;
}

export function OperatorRetryButton({ runId, expectedOrganizationId, expectedInstallationId, expectedConversationId }: { runId: string; expectedOrganizationId?: string; expectedInstallationId?: string; expectedConversationId?: string | null }) {
  return <OperatorRecoveryCommandButton commandType="retry_run" targetId={runId} label="Retry run" completedMessage="Run retry dispatched." payload={{ ...(expectedOrganizationId ? { expectedOrganizationId } : {}), ...(expectedInstallationId ? { expectedInstallationId } : {}), ...(expectedConversationId ? { expectedConversationId } : {}) }} />;
}

export function OperatorCancelRunButton({ runId, expectedOrganizationId, expectedInstallationId, expectedConversationId }: { runId: string; expectedOrganizationId?: string; expectedInstallationId?: string; expectedConversationId?: string | null }) {
  return <OperatorRecoveryCommandButton
    commandType="cancel_run"
    targetId={runId}
    label="Cancel run"
    completedMessage="Cancellation signal sent."
    payload={{ ...(expectedOrganizationId ? { expectedOrganizationId } : {}), ...(expectedInstallationId ? { expectedInstallationId } : {}), ...(expectedConversationId ? { expectedConversationId } : {}) }}
    confirmMessage="Send a cancellation signal to this run?"
  />;
}

export function OperatorExportRequestButton({ runId, organizationId }: { runId: string; organizationId: string }) {
  return <OperatorRecoveryCommandButton
    commandType="request_export"
    targetId={runId}
    label="Request run export"
    completedMessage="Export request queued."
    payload={{ scopeType: "run", scopeId: runId, organizationId }}
    confirmMessage="Queue a metadata export request for this run? A second operator must approve the request."
  />;
}

export function OperatorKillSwitchDisableButton({ switchId, expectedOrganizationId }: { switchId: string; expectedOrganizationId?: string | null }) {
  return <OperatorRecoveryCommandButton
    commandType="kill_switch_disable"
    targetId={switchId}
    label="Disable"
    completedMessage="Kill switch disabled."
    payload={expectedOrganizationId ? { expectedOrganizationId } : {}}
    confirmMessage="Disable this kill switch?"
  />;
}

export function OperatorKillSwitchEnableButton({ organizationId }: { organizationId?: string }) {
  const [scopeType, setScopeType] = useState<"organization" | "agent" | "installation" | "tool">("organization");
  const [scopeId, setScopeId] = useState(organizationId ?? "");
  const [reason, setReason] = useState("");
  const [command, setCommand] = useState<Command | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function start() {
    if (!scopeId.trim() || !reason.trim()) { setMessage("Scope ID and reason are required."); return; }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/operations/commands", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `admin-kill-switch-${scopeType}-${scopeId}-${Date.now()}` },
        body: JSON.stringify({ commandType: "kill_switch_enable", targetId: `${scopeType}:${scopeId}`, payload: { scopeType, scopeId: scopeId.trim(), reason: reason.trim(), ...(organizationId ? { organizationId } : {}) } }),
      });
      const data = await response.json() as Command & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Unable to create kill-switch command");
      setCommand(data);
      setMessage(data.status === "awaiting_approval" ? "Second operator approval required." : "Kill switch enabled.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to create kill-switch command");
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!command) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/operations/commands/${encodeURIComponent(command.id)}/approve`, { method: "POST" });
      const data = await response.json() as Command & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Unable to approve kill-switch command");
      setCommand(data);
      setMessage("Kill switch enabled.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to approve kill-switch command");
    } finally {
      setBusy(false);
    }
  }

  return <div className="flex flex-wrap items-center justify-end gap-2"><select value={scopeType} onChange={(event) => setScopeType(event.target.value as typeof scopeType)} disabled={busy} className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"><option value="organization">Organization</option><option value="agent">Agent</option><option value="installation">Installation</option><option value="tool">Tool</option></select><input value={scopeId} onChange={(event) => setScopeId(event.target.value)} disabled={busy} placeholder="Scope ID" className="h-8 w-36 rounded-md border border-border bg-background px-2 text-xs text-foreground" /><input value={reason} onChange={(event) => setReason(event.target.value)} disabled={busy} placeholder="Reason" className="h-8 w-40 rounded-md border border-border bg-background px-2 text-xs text-foreground" /><button type="button" disabled={busy || Boolean(command && command.status !== "failed")} onClick={() => void start()} className={buttonClassName({ variant: "secondary", size: "sm" })}>{busy ? "Submitting…" : "Enable kill switch"}</button>{command?.status === "awaiting_approval" ? <button type="button" disabled={busy} onClick={() => void approve()} className={buttonClassName({ variant: "secondary", size: "sm" })}>{busy ? "Approving…" : "Approve"}</button> : null}{message ? <span className="w-full text-right text-[11px] text-muted-foreground">{message}</span> : null}</div>;
}

function OperatorDualControlForm({ commandType, targetId, payload, label, completedMessage }: { commandType: "set_feature_flag" | "create_hold" | "set_retention_policy" | "create_legal_hold"; targetId: string; payload: Record<string, unknown>; label: string; completedMessage: string }) {
  const [command, setCommand] = useState<Command | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function start() {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch("/api/operations/commands", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": `admin-${commandType}-${targetId}-${Date.now()}` }, body: JSON.stringify({ commandType, targetId, payload }) });
      const data = await response.json() as Command & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Unable to create operator control command");
      setCommand(data); setMessage(data.status === "awaiting_approval" ? "Second operator approval required." : completedMessage);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to create operator control command"); } finally { setBusy(false); }
  }
  async function approve() {
    if (!command) return;
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(`/api/operations/commands/${encodeURIComponent(command.id)}/approve`, { method: "POST" });
      const data = await response.json() as Command & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Unable to approve operator control command");
      setCommand(data); setMessage(completedMessage);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to approve operator control command"); } finally { setBusy(false); }
  }
  return <div className="flex flex-col items-end gap-1"><button type="button" disabled={busy || Boolean(command && command.status !== "failed")} onClick={() => void start()} className={buttonClassName({ variant: "secondary", size: "sm" })}>{busy ? "Submitting…" : label}</button>{command?.status === "awaiting_approval" ? <button type="button" disabled={busy} onClick={() => void approve()} className={buttonClassName({ variant: "secondary", size: "sm" })}>{busy ? "Approving…" : "Approve"}</button> : null}{message ? <span className="max-w-64 text-right text-[11px] text-muted-foreground">{message}</span> : null}</div>;
}

export function OperatorFeatureFlagForm() {
  const [flagKey, setFlagKey] = useState("agent_execution_enabled");
  const [scopeType, setScopeType] = useState<"global" | "organization" | "installation">("organization");
  const [scopeId, setScopeId] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const expires = expiresAt ? new Date(expiresAt).toISOString() : "";
  return <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4"><select value={flagKey} onChange={(event) => setFlagKey(event.target.value)} className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"><option value="agent_execution_enabled">Agent execution</option><option value="effect_execution_enabled">External effects</option><option value="mcp_enabled">MCP</option><option value="rest_enabled">REST</option></select><select value={scopeType} onChange={(event) => { const value = event.target.value as typeof scopeType; setScopeType(value); if (value === "global") setScopeId("global"); }} className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"><option value="global">Global</option><option value="organization">Organization</option><option value="installation">Installation</option></select><input value={scopeId} onChange={(event) => setScopeId(event.target.value)} placeholder="Scope ID" className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground" /><input value={organizationId} onChange={(event) => setOrganizationId(event.target.value)} placeholder="Organization ID" className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground" /><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason" className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground" /><input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground" /><label className="flex items-center gap-2 text-xs text-foreground"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Enable flag</label><OperatorDualControlForm commandType="set_feature_flag" targetId={`${scopeType}:${scopeId}:${flagKey}`} payload={{ flagKey, scopeType, scopeId: scopeType === "global" ? "global" : scopeId, ...(scopeType !== "global" ? { organizationId } : {}), enabled, reason, expiresAt: expires }} label="Save flag" completedMessage="Feature flag saved." /></div>;
}

export function OperatorHoldForm() {
  const [holdType, setHoldType] = useState<"execution" | "effects" | "delivery">("execution");
  const [scopeType, setScopeType] = useState<"organization" | "installation" | "run">("organization");
  const [scopeId, setScopeId] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const expires = expiresAt ? new Date(expiresAt).toISOString() : "";
  return <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4"><select value={holdType} onChange={(event) => setHoldType(event.target.value as typeof holdType)} className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"><option value="execution">Execution hold</option><option value="effects">Effects hold</option><option value="delivery">Delivery hold</option></select><select value={scopeType} onChange={(event) => setScopeType(event.target.value as typeof scopeType)} className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"><option value="organization">Organization</option><option value="installation">Installation</option><option value="run">Run</option></select><input value={scopeId} onChange={(event) => setScopeId(event.target.value)} placeholder="Scope ID" className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground" /><input value={organizationId} onChange={(event) => setOrganizationId(event.target.value)} placeholder="Organization ID" className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground" /><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason" className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground" /><input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground" /><OperatorDualControlForm commandType="create_hold" targetId={scopeId} payload={{ organizationId, scopeType, scopeId, holdType, reason, expiresAt: expires }} label="Create hold" completedMessage="Incident hold created." /></div>;
}

export function OperatorHoldReleaseButton({ holdId, expectedOrganizationId }: { holdId: string; expectedOrganizationId: string }) {
  return <OperatorRecoveryCommandButton commandType="release_hold" targetId={holdId} label="Release" completedMessage="Incident hold released." payload={{ expectedOrganizationId, expectedStatus: "active" }} confirmMessage="Release this incident hold?" />;
}

export function OperatorRetentionPolicyForm() {
  const [organizationId, setOrganizationId] = useState("");
  const [memoryDays, setMemoryDays] = useState("365");
  const [conversationDays, setConversationDays] = useState("365");
  const [eventDays, setEventDays] = useState("365");
  const [auditDays, setAuditDays] = useState("2555");
  const [attachmentDays, setAttachmentDays] = useState("30");
  return <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4"><input value={organizationId} onChange={(event) => setOrganizationId(event.target.value)} placeholder="Organization ID" className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground" /><input type="number" min={1} max={3650} value={memoryDays} onChange={(event) => setMemoryDays(event.target.value)} placeholder="Memory days" className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground" /><input type="number" min={1} max={3650} value={conversationDays} onChange={(event) => setConversationDays(event.target.value)} placeholder="Conversation days" className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground" /><input type="number" min={1} max={3650} value={eventDays} onChange={(event) => setEventDays(event.target.value)} placeholder="Event days" className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground" /><input type="number" min={30} max={3650} value={auditDays} onChange={(event) => setAuditDays(event.target.value)} placeholder="Audit days" className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground" /><input type="number" min={1} max={3650} value={attachmentDays} onChange={(event) => setAttachmentDays(event.target.value)} placeholder="Attachment days" className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground" /><OperatorDualControlForm commandType="set_retention_policy" targetId={organizationId} payload={{ memoryDays: Number(memoryDays), conversationDays: Number(conversationDays), eventDays: Number(eventDays), auditDays: Number(auditDays), attachmentDays: Number(attachmentDays) }} label="Save policy" completedMessage="Retention policy saved." /></div>;
}

export function OperatorRetentionApplyButton({ organizationId }: { organizationId: string }) {
  return <OperatorRecoveryCommandButton commandType="apply_retention_policy" targetId={organizationId} label="Apply memory retention" completedMessage="Retention policy applied; eligible memory is queued for deletion." payload={{ expectedOrganizationId: organizationId }} confirmMessage="Expire eligible memory for this organization and queue deletion jobs? A second operator must approve." />;
}

export function OperatorLegalHoldForm() {
  const [organizationId, setOrganizationId] = useState("");
  const [scopeType, setScopeType] = useState<"organization" | "installation" | "conversation">("organization");
  const [scopeId, setScopeId] = useState("");
  const [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const expires = expiresAt ? new Date(expiresAt).toISOString() : undefined;
  return <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4"><input value={organizationId} onChange={(event) => setOrganizationId(event.target.value)} placeholder="Organization ID" className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground" /><select value={scopeType} onChange={(event) => { const value = event.target.value as typeof scopeType; setScopeType(value); if (value === "organization") setScopeId(organizationId); }} className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"><option value="organization">Organization</option><option value="installation">Installation</option><option value="conversation">Conversation</option></select><input value={scopeId} onChange={(event) => setScopeId(event.target.value)} placeholder="Scope ID" className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground" /><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason (8+ chars)" className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground" /><input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground" /><OperatorDualControlForm commandType="create_legal_hold" targetId={scopeId} payload={{ organizationId, scopeType, scopeId, reason, ...(expires ? { expiresAt: expires } : {}) }} label="Create legal hold" completedMessage="Legal hold created." /></div>;
}

export function OperatorLegalHoldReleaseButton({ holdId, expectedOrganizationId }: { holdId: string; expectedOrganizationId: string }) {
  return <OperatorRecoveryCommandButton commandType="release_legal_hold" targetId={holdId} label="Release legal hold" completedMessage="Legal hold released." payload={{ expectedOrganizationId, expectedStatus: "active" }} confirmMessage="Release this legal hold? A second operator must approve." />;
}

export function OperatorAssignRunButton({ runId, expectedStatus, assigneeId, expectedOrganizationId, expectedInstallationId, expectedConversationId }: { runId: string; expectedStatus: string; assigneeId: string; expectedOrganizationId?: string; expectedInstallationId?: string; expectedConversationId?: string | null }) {
  const [command, setCommand] = useState<Command | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/operations/commands", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `admin-assign-run-${runId}-${assigneeId}-${Date.now()}` },
        body: JSON.stringify({ commandType: "assign_run", targetId: runId, payload: { assigneeId, expectedStatus, ...(expectedOrganizationId ? { expectedOrganizationId } : {}), ...(expectedInstallationId ? { expectedInstallationId } : {}), ...(expectedConversationId ? { expectedConversationId } : {}) } }),
      });
      const data = await response.json() as Command & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Unable to assign run");
      setCommand(data);
      setMessage(data.status === "awaiting_approval" ? "Second operator approval required." : "Run assigned.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to assign run");
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!command) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/operations/commands/${encodeURIComponent(command.id)}/approve`, { method: "POST" });
      const data = await response.json() as Command & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Unable to approve run assignment");
      setCommand(data);
      setMessage(data.status === "completed" ? "Run assigned." : "Approval recorded.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to approve run assignment");
    } finally {
      setBusy(false);
    }
  }

  return <div className="flex flex-col items-end gap-1">{!command || command.status === "failed" ? <button type="button" disabled={busy} onClick={() => void start()} className={buttonClassName({ variant: "ghost", size: "sm" })}>{busy ? "Submitting…" : "Assign to me"}</button> : null}{command?.status === "awaiting_approval" ? <button type="button" disabled={busy} onClick={() => void approve()} className={buttonClassName({ variant: "secondary", size: "sm" })}>{busy ? "Approving…" : "Approve assignment"}</button> : null}{message ? <span className="max-w-48 text-right text-[11px] text-muted-foreground">{message}</span> : null}</div>;
}

export function OperatorDeliveryReplayButton({ attemptId, status, expectedOrganizationId, expectedInstallationId, expectedConversationId }: { attemptId: string; status: "failed" | "unknown"; expectedOrganizationId?: string; expectedInstallationId?: string; expectedConversationId?: string }) {
  return <OperatorRecoveryCommandButton
    commandType="replay_delivery"
    targetId={attemptId}
    label={status === "unknown" ? "Confirm & replay" : "Replay delivery"}
    completedMessage="Delivery replay queued."
    payload={{ ...(status === "unknown" ? { confirmUnknown: true } : {}), ...(expectedOrganizationId ? { expectedOrganizationId } : {}), ...(expectedInstallationId ? { expectedInstallationId } : {}), ...(expectedConversationId ? { expectedConversationId } : {}) }}
  />;
}

export function OperatorDeleteMemoryButton({ memoryId, expectedOrganizationId, expectedAgentId, expectedInstallationId, expectedConversationId }: { memoryId: string; expectedOrganizationId?: string; expectedAgentId?: string | null; expectedInstallationId?: string | null; expectedConversationId?: string | null }) {
  return <OperatorRecoveryCommandButton
    commandType="delete_memory"
    targetId={memoryId}
    label="Request deletion"
    completedMessage="Memory deletion completed."
    payload={{ expectedStatus: "active", ...(expectedOrganizationId ? { expectedOrganizationId } : {}), ...(expectedAgentId ? { expectedAgentId } : {}), ...(expectedInstallationId ? { expectedInstallationId } : {}), ...(expectedConversationId ? { expectedConversationId } : {}) }}
    confirmMessage="Request deletion of this memory? A second operator must approve the request."
  />;
}
