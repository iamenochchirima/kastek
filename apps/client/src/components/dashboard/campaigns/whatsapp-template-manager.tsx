"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  TEMPLATE_CATEGORY_OPTIONS,
  TEMPLATE_LIBRARY,
  categoryLabel,
  type TemplateCategoryValue,
} from "@/lib/whatsapp/template-library";

type TemplateView = {
  id: string;
  templateName: string;
  language: string;
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION";
  status: "APPROVED" | "PENDING" | "REJECTED" | "DISABLED";
  variablesCount: number;
  body: string | null;
  lastSynced: string | null;
  connectionLabel: string;
};

type ConnectionView = {
  id: string;
  phoneDisplayNumber: string | null;
  phoneNumberId: string;
};

const STATUS_STYLES: Record<TemplateView["status"], string> = {
  APPROVED: "border-green-500/30 bg-green-500/10 text-green-300",
  PENDING: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  REJECTED: "border-red-500/30 bg-red-500/10 text-red-300",
  DISABLED: "border-zinc-500/30 bg-zinc-500/10 text-zinc-300",
};

const LANGUAGE_OPTIONS = [
  { value: "en_US", label: "English (US)" },
  { value: "en_GB", label: "English (UK)" },
  { value: "af", label: "Afrikaans" },
  { value: "zu", label: "Zulu" },
  { value: "xh", label: "Xhosa" },
];

function hasLeadingOrTrailingVariable(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return false;

  return /^{{\d+}}/.test(trimmed) || /{{\d+}}$/.test(trimmed);
}

function getVariablePlacementError(input: { header: string; body: string; footer: string }) {
  if (hasLeadingOrTrailingVariable(input.header)) {
    return "Header variables cannot be at the start or end of the text.";
  }

  if (hasLeadingOrTrailingVariable(input.body)) {
    return "Body variables cannot be at the start or end of the template.";
  }

  if (hasLeadingOrTrailingVariable(input.footer)) {
    return "Footer variables cannot be at the start or end of the text.";
  }

  return "";
}

function renderPreviewText(value: string) {
  if (!value.trim()) return "";
  return value.replace(/{{(\d+)}}/g, (_, token) => `[${token}]`);
}

export default function WhatsappTemplateManager({
  templates,
  connections,
  initialLibraryItemId,
  forceCreateForm = false,
}: {
  templates: TemplateView[];
  connections: ConnectionView[];
  initialLibraryItemId?: string;
  forceCreateForm?: boolean;
}) {
  const router = useRouter();
  const shouldChooseConnection = connections.length > 2;
  const [connectionId, setConnectionId] = useState(connections[0]?.id || "");
  const [templateName, setTemplateName] = useState("");
  const [language, setLanguage] = useState("en_US");
  const [category, setCategory] = useState<TemplateCategoryValue>("MARKETING");
  const [header, setHeader] = useState("");
  const [body, setBody] = useState("");
  const [footer, setFooter] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(
    forceCreateForm || Boolean(initialLibraryItemId) || templates.length === 0,
  );
  const [submitting, setSubmitting] = useState(false);
  const [syncingConnectionId, setSyncingConnectionId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const activeConnection =
    connections.find((connection) => connection.id === connectionId) || connections[0] || null;
  const previewBody = renderPreviewText(body);
  const previewHeader = renderPreviewText(header);
  const previewFooter = renderPreviewText(footer);
  const variablePlacementError = getVariablePlacementError({ header, body, footer });
  const displayError = variablePlacementError || error;

  useEffect(() => {
    if (!initialLibraryItemId) return;
    const starter = TEMPLATE_LIBRARY.find((item) => item.id === initialLibraryItemId);
    if (!starter) return;

    setCategory(starter.category);
    setHeader(starter.header || "");
    setBody(starter.body);
    setFooter(starter.footer || "");
    setTemplateName((current) =>
      current || starter.title.toLowerCase().replace(/[^a-z0-9_]+/g, "_")
    );
    setShowCreateForm(true);
  }, [initialLibraryItemId]);

  useEffect(() => {
    if (forceCreateForm) {
      setShowCreateForm(true);
    }
  }, [forceCreateForm]);

  async function handleCreateTemplate() {
    setSubmitting(true);
    setError("");
    setNotice("");

    if (variablePlacementError) {
      setError(variablePlacementError);
      setSubmitting(false);
      return;
    }

    try {
      const res = await fetch("/api/whatsapp/templates", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          connectionId,
          templateName,
          language,
          category,
          header: header || undefined,
          body,
          footer: footer || undefined,
        }),
      });

      const payload = await res.json();
      if (!res.ok) {
        console.error("Template submission failed", {
          status: res.status,
          payload,
          request: {
            connectionId,
            templateName,
            language,
            category,
            header: header || undefined,
            body,
            footer: footer || undefined,
          },
        });
        throw new Error(payload.error || "Failed to create template");
      }

      setNotice(
        payload.status === "APPROVED"
          ? "Template created and approved."
          : "Template submitted to Meta for review. Approval may take time on newer accounts."
      );
      setTemplateName("");
      setHeader("");
      setBody("");
      setFooter("");
      setCategory("MARKETING");
      setShowCreateForm(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create template");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSync(connectionIdToSync: string) {
    setSyncingConnectionId(connectionIdToSync);
    setError("");
    setNotice("");

    try {
      const res = await fetch(`/api/whatsapp/connections/${connectionIdToSync}/templates/sync`, {
        method: "POST",
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(payload.error || "Failed to sync templates");
      }

      setNotice(`Template sync completed. Synced ${payload.synced || 0} WhatsApp templates.`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sync templates");
    } finally {
      setSyncingConnectionId(null);
    }
  }

  return (
    <div className="space-y-6">
      {(displayError || notice) && (
        <div
          className={`rounded-lg border px-3 py-2 text-xs ${
            displayError
              ? "border-red-500/30 bg-red-500/10 text-red-300"
              : "border-green-500/30 bg-green-500/10 text-green-300"
          }`}
        >
          {displayError || notice}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setShowCreateForm((current) => !current)}
            className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
          >
            {showCreateForm ? "Close creator" : "Create new template"}
          </button>

          <div className="flex flex-wrap gap-2">
            {connections.map((connection) => (
              <button
                key={connection.id}
                type="button"
                onClick={() => handleSync(connection.id)}
                disabled={syncingConnectionId === connection.id}
                className="rounded-lg border border-border bg-secondary/50 px-3 py-2 text-xs text-foreground transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-60"
              >
                {syncingConnectionId === connection.id
                  ? "Syncing..."
                  : `Sync ${connection.phoneDisplayNumber || connection.phoneNumberId}`}
              </button>
            ))}
          </div>
        </div>

        {templates.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-secondary/50 px-6 py-14 text-center">
            <p className="mb-2 text-lg font-semibold text-foreground">No templates yet</p>
            <p className="mx-auto mb-6 max-w-xl text-sm text-muted-foreground">
              Create your first WhatsApp template here, or start from the Template Library and then
              customize it before submitting to Meta.
            </p>
            <button
              type="button"
              onClick={() => setShowCreateForm(true)}
              className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground"
            >
              Create new template
            </button>
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {templates.map((template) => (
              <div key={template.id} className="rounded-xl border border-border bg-secondary/40 p-5">
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold text-foreground">{template.templateName}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {categoryLabel(template.category)} · {template.language}
                    </p>
                  </div>
                  <span
                    className={`rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.18em] ${STATUS_STYLES[template.status]}`}
                  >
                    {template.status}
                  </span>
                </div>

                <div className="rounded-lg border border-border bg-card p-3">
                  <p className="line-clamp-4 whitespace-pre-wrap text-sm text-muted-foreground">
                    {template.body || "No template body saved."}
                  </p>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <TemplateMeta label="Variables" value={String(template.variablesCount)} />
                  <TemplateMeta label="Connection" value={template.connectionLabel} />
                  <TemplateMeta
                    label="Last synced"
                    value={
                      template.lastSynced
                        ? new Date(template.lastSynced).toLocaleDateString("en-ZA")
                        : "Never"
                    }
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {showCreateForm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="max-h-[92vh] w-full max-w-6xl overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-2xl">
            <div className="mb-5 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Create template</h2>
                <p className="text-sm text-muted-foreground">
                  Build a new WhatsApp template and submit it to Meta for approval.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowCreateForm(false)}
                className="rounded-lg border border-border bg-secondary/50 px-4 py-2 text-sm text-foreground transition-colors hover:bg-secondary"
              >
                Close
              </button>
            </div>

            <div className="mb-6">
              <p className="mb-3 text-sm font-medium text-foreground">Template type</p>
              <div className="grid gap-3 lg:grid-cols-3">
                {TEMPLATE_CATEGORY_OPTIONS.map((option) => {
                  const selected = option.value === category;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setCategory(option.value)}
                      className={`rounded-xl border p-4 text-left transition-colors ${
                        selected
                          ? "border-primary/30 bg-primary/10"
                          : "border-border bg-secondary/50 hover:border-primary/20"
                      }`}
                    >
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <span className="text-base font-semibold text-foreground">{option.label}</span>
                        <span className="rounded-full border border-border px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                          {option.badge}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground">{option.description}</p>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_380px]">
              <div className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  {shouldChooseConnection ? (
                    <label className="space-y-2 text-sm">
                      <span className="text-muted-foreground">Connection</span>
                      <select
                        value={connectionId}
                        onChange={(event) => setConnectionId(event.target.value)}
                        className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
                      >
                        {connections.map((connection) => (
                          <option key={connection.id} value={connection.id}>
                            {connection.phoneDisplayNumber || connection.phoneNumberId}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <div className="space-y-2 text-sm">
                      <span className="text-muted-foreground">Using connection</span>
                      <div className="rounded-lg border border-border bg-secondary px-3 py-2 text-foreground">
                        {activeConnection?.phoneDisplayNumber || activeConnection?.phoneNumberId || "-"}
                      </div>
                    </div>
                  )}

                  <label className="space-y-2 text-sm">
                    <span className="text-muted-foreground">Language</span>
                    <select
                      value={language}
                      onChange={(event) => setLanguage(event.target.value)}
                      className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
                    >
                      {LANGUAGE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <label className="space-y-2 text-sm">
                  <span className="text-muted-foreground">Template name</span>
                  <input
                    value={templateName}
                    onChange={(event) => setTemplateName(event.target.value)}
                    placeholder="promo_launch_april"
                    className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
                  />
                  <p className="text-xs text-muted-foreground">
                    Use lowercase letters, numbers, and underscores only.
                  </p>
                </label>

                <label className="space-y-2 text-sm">
                  <span className="text-muted-foreground">Header (optional)</span>
                  <input
                    value={header}
                    onChange={(event) => setHeader(event.target.value)}
                    placeholder="KasiTek Update"
                    className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
                  />
                </label>

                <label className="space-y-2 text-sm">
                  <span className="text-muted-foreground">Body</span>
                  <textarea
                    value={body}
                    onChange={(event) => setBody(event.target.value)}
                    rows={6}
                    placeholder="Hi {{1}}, your next offer is ready. Reply STOP to opt out."
                    className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
                  />
                  <p className="text-xs text-muted-foreground">
                    Use placeholders like {"{{1}}"} when the template needs variables.
                  </p>
                  {hasLeadingOrTrailingVariable(body) ? (
                    <p className="text-xs text-amber-300">
                      Variables cannot appear at the start or end of the template.
                    </p>
                  ) : null}
                </label>

                <label className="space-y-2 text-sm">
                  <span className="text-muted-foreground">Footer (optional)</span>
                  <input
                    value={footer}
                    onChange={(event) => setFooter(event.target.value)}
                    placeholder="Reply STOP to unsubscribe"
                    className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
                  />
                </label>

                <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-muted-foreground">
                    Meta reviews every template after submission. Newer accounts may wait longer.
                  </p>
                  <button
                    type="button"
                    onClick={handleCreateTemplate}
                    disabled={submitting || !connectionId || Boolean(variablePlacementError)}
                    className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {submitting ? "Submitting..." : "Submit template"}
                  </button>
                </div>
              </div>

              <div className="lg:sticky lg:top-6">
                <div className="overflow-hidden rounded-[28px] border border-border bg-[#d7e3c6] shadow-[0_20px_60px_rgba(0,0,0,0.18)]">
                  <div className="flex items-center justify-between border-b border-black/5 bg-[#e6efda] px-4 py-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">WhatsApp Preview</p>
                      <p className="text-[11px] text-slate-600">
                        {activeConnection?.phoneDisplayNumber || activeConnection?.phoneNumberId || "Connected number"}
                      </p>
                    </div>
                    <span className="rounded-full bg-white/70 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.2em] text-slate-500">
                      {categoryLabel(category)}
                    </span>
                  </div>

                  <div className="bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.65),_transparent_34%),linear-gradient(180deg,_#dfead0_0%,_#cadab8_100%)] p-4">
                    <div className="ml-auto max-w-[290px] rounded-[20px] rounded-tr-md bg-[#f6f1df] px-4 py-3 text-slate-900 shadow-[0_8px_24px_rgba(0,0,0,0.08)]">
                      {previewHeader ? (
                        <p className="mb-2 text-[13px] font-semibold tracking-[0.01em]">
                          {previewHeader}
                        </p>
                      ) : null}

                      <p className="whitespace-pre-wrap text-[13px] leading-6 text-slate-800">
                        {previewBody || "Your message preview will appear here as you type."}
                      </p>

                      {previewFooter ? (
                        <p className="mt-3 border-t border-black/10 pt-2 text-[11px] text-slate-500">
                          {previewFooter}
                        </p>
                      ) : null}

                      <div className="mt-3 flex items-center justify-between text-[10px] text-slate-500">
                        <span>{templateName || "template_name"}</span>
                        <span>{language}</span>
                      </div>
                    </div>

                    <div className="mt-4 rounded-2xl bg-white/60 px-4 py-3 text-[11px] text-slate-600 backdrop-blur-sm">
                      <p className="font-medium text-slate-700">Variable preview</p>
                      <p className="mt-1">
                        Placeholders like {"{{1}}"} render as bracket markers such as <span className="font-semibold text-slate-800">[1]</span> in the preview.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TemplateMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-[11px] uppercase tracking-[0.15em] text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}
