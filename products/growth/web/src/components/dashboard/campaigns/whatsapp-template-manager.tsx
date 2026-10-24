"use client";

import { apiUrl } from "@/lib/server-api";
import { useEffect, useState } from "react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
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
  header: string | null;
  body: string | null;
  footer: string | null;
  buttons: unknown;
  lastSynced: string | null;
  connectionLabel: string;
};

type ConnectionView = {
  id: string;
  phoneDisplayNumber: string | null;
  phoneNumberId: string;
};

const STATUS_STYLES: Record<TemplateView["status"], string> = {
  APPROVED: "border-status-success/30 bg-status-success-soft text-status-success",
  PENDING: "border-status-attention/30 bg-status-attention-soft text-status-attention",
  REJECTED: "border-destructive/30 bg-status-danger-soft text-destructive",
  DISABLED: "border-border bg-secondary text-muted-foreground",
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
  const revalidator = useRevalidator();
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
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const activeConnection =
    connections.find((connection) => connection.id === connectionId) || connections[0] || null;
  const previewBody = renderPreviewText(body);
  const previewHeader = renderPreviewText(header);
  const previewFooter = renderPreviewText(footer);
  const variablePlacementError = getVariablePlacementError({ header, body, footer });
  const displayError = variablePlacementError || error;
  const selectedTemplate =
    templates.find((template) => template.id === selectedTemplateId) || null;

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

    if (variablePlacementError) {
      setError(variablePlacementError);
      setSubmitting(false);
      return;
    }

    try {
      const res = await fetch(apiUrl("/api/whatsapp/templates"), {
        method: "POST",
        credentials: "include",
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

      toast.success(payload.status === "APPROVED" ? "Template approved" : "Template submitted");
      setTemplateName("");
      setHeader("");
      setBody("");
      setFooter("");
      setCategory("MARKETING");
      setShowCreateForm(false);
      revalidator.revalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create template");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSync(connectionIdToSync: string) {
    setSyncingConnectionId(connectionIdToSync);
    setError("");

    try {
      const res = await fetch(apiUrl(`/api/whatsapp/connections/${connectionIdToSync}/templates/sync`), {
        method: "POST",
        credentials: "include",
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(payload.error || "Failed to sync templates");
      }

      toast.success("Templates synced", { description: `${payload.synced || 0} templates updated` });
      revalidator.revalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sync templates");
    } finally {
      setSyncingConnectionId(null);
    }
  }

  return (
    <div className="space-y-6">
      {displayError && (
        <div
          className={`rounded-lg border px-3 py-2 text-xs ${
            displayError
              ? "border-destructive/30 bg-status-danger-soft text-destructive"
              : "border-status-success/30 bg-status-success-soft text-status-success"
          }`}
        >
          {displayError}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <Button
            onClick={() => setShowCreateForm((current) => !current)}
          >
            {showCreateForm ? "Close creator" : "Create new template"}
          </Button>

          <div className="flex flex-wrap gap-2">
            {connections.map((connection) => (
              <Button
                key={connection.id}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => handleSync(connection.id)}
                disabled={syncingConnectionId === connection.id}
              >
                {syncingConnectionId === connection.id
                  ? "Syncing..."
                  : `Sync ${connection.phoneDisplayNumber || connection.phoneNumberId}`}
              </Button>
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
            <Button
              onClick={() => setShowCreateForm(true)}
            >
              Create new template
            </Button>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
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
                  <p className="line-clamp-6 whitespace-pre-wrap text-sm text-muted-foreground">
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

                <div className="mt-4">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSelectedTemplateId(template.id)}
                  >
                    View full details
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <Dialog open={selectedTemplate !== null} onOpenChange={(open) => { if (!open) setSelectedTemplateId(null); }}>
        <DialogContent showCloseButton={false} className="max-h-[92svh] max-w-4xl overflow-y-auto">
          {selectedTemplate ? (
            <>
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <DialogTitle>
                  {selectedTemplate.templateName}
                </DialogTitle>
                <DialogDescription className="mt-1">
                  {categoryLabel(selectedTemplate.category)} · {selectedTemplate.language}
                </DialogDescription>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={`rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.18em] ${STATUS_STYLES[selectedTemplate.status]}`}
                >
                  {selectedTemplate.status}
                </span>
                <Button
                  variant="outline"
                  onClick={() => setSelectedTemplateId(null)}
                >
                  Close
                </Button>
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_320px]">
              <div className="space-y-4">
                <TemplateDetailBlock
                  label="Header"
                  value={selectedTemplate.header || "No header"}
                />
                <TemplateDetailBlock
                  label="Body"
                  value={selectedTemplate.body || "No body saved."}
                  preserveWhitespace
                />
                <TemplateDetailBlock
                  label="Footer"
                  value={selectedTemplate.footer || "No footer"}
                />
                <TemplateDetailBlock
                  label="Buttons"
                  value={
                    selectedTemplate.buttons
                      ? JSON.stringify(selectedTemplate.buttons, null, 2)
                      : "No buttons configured"
                  }
                  preserveWhitespace
                />
              </div>

              <div className="space-y-3">
                <TemplateMeta label="Variables" value={String(selectedTemplate.variablesCount)} />
                <TemplateMeta label="Connection" value={selectedTemplate.connectionLabel} />
                <TemplateMeta
                  label="Last synced"
                  value={
                    selectedTemplate.lastSynced
                      ? new Date(selectedTemplate.lastSynced).toLocaleString("en-ZA")
                      : "Never"
                  }
                />
              </div>
            </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={showCreateForm} onOpenChange={setShowCreateForm}>
        <DialogContent showCloseButton={false} className="max-h-[92svh] max-w-6xl overflow-y-auto">
          {showCreateForm ? (
            <>
            <div className="mb-5 flex items-center justify-between gap-4">
              <div>
                <DialogTitle>Create template</DialogTitle>
                <DialogDescription>
                  Build a new WhatsApp template and submit it to Meta for approval.
                </DialogDescription>
              </div>
              <Button
                variant="outline"
                onClick={() => setShowCreateForm(false)}
              >
                Close
              </Button>
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
                      <Select value={connectionId} onValueChange={setConnectionId}>
                        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>
                        {connections.map((connection) => (
                          <SelectItem key={connection.id} value={connection.id}>
                            {connection.phoneDisplayNumber || connection.phoneNumberId}
                          </SelectItem>
                        ))}
                        </SelectContent>
                      </Select>
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
                    <Select value={language} onValueChange={setLanguage}>
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                      {LANGUAGE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                      </SelectContent>
                    </Select>
                  </label>
                </div>

                <label className="space-y-2 text-sm">
                  <span className="text-muted-foreground">Template name</span>
                  <Input
                    value={templateName}
                    onChange={(event) => setTemplateName(event.target.value)}
                    placeholder="promo_launch_april"
                  />
                  <p className="text-xs text-muted-foreground">
                    Use lowercase letters, numbers, and underscores only.
                  </p>
                </label>

                <label className="space-y-2 text-sm">
                  <span className="text-muted-foreground">Header (optional)</span>
                  <Input
                    value={header}
                    onChange={(event) => setHeader(event.target.value)}
                    placeholder="KasiTek Update"
                  />
                </label>

                <label className="space-y-2 text-sm">
                  <span className="text-muted-foreground">Body</span>
                  <Textarea
                    value={body}
                    onChange={(event) => setBody(event.target.value)}
                    rows={6}
                    placeholder="Hi {{1}}, your next offer is ready. Reply STOP to opt out."
                  />
                  <p className="text-xs text-muted-foreground">
                    Use placeholders like {"{{1}}"} when the template needs variables.
                  </p>
                  {hasLeadingOrTrailingVariable(body) ? (
                    <p className="text-xs text-status-attention">
                      Variables cannot appear at the start or end of the template.
                    </p>
                  ) : null}
                </label>

                <label className="space-y-2 text-sm">
                  <span className="text-muted-foreground">Footer (optional)</span>
                  <Input
                    value={footer}
                    onChange={(event) => setFooter(event.target.value)}
                    placeholder="Reply STOP to unsubscribe"
                  />
                </label>

                <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-muted-foreground">
                    Meta reviews every template after submission. Newer accounts may wait longer.
                  </p>
                  <Button
                    onClick={handleCreateTemplate}
                    disabled={submitting || !connectionId || Boolean(variablePlacementError)}
                  >
                    {submitting ? "Submitting..." : "Submit template"}
                  </Button>
                </div>
              </div>

              <div className="lg:sticky lg:top-6">
                <div className="overflow-hidden rounded-lg border border-border bg-secondary">
                  <div className="flex items-center justify-between border-b border-border bg-card px-4 py-3">
                    <div>
                      <p className="text-sm font-semibold text-foreground">WhatsApp Preview</p>
                      <p className="text-[11px] text-muted-foreground">
                        {activeConnection?.phoneDisplayNumber || activeConnection?.phoneNumberId || "Connected number"}
                      </p>
                    </div>
                    <span className="rounded-md bg-secondary px-2 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                      {categoryLabel(category)}
                    </span>
                  </div>

                  <div className="p-4">
                    <div className="ml-auto max-w-[290px] rounded-lg rounded-tr-md border border-border bg-card px-4 py-3 text-foreground">
                      {previewHeader ? (
                        <p className="mb-2 text-[13px] font-semibold tracking-[0.01em]">
                          {previewHeader}
                        </p>
                      ) : null}

                      <p className="whitespace-pre-wrap text-[13px] leading-6 text-foreground">
                        {previewBody || "Your message preview will appear here as you type."}
                      </p>

                      {previewFooter ? (
                        <p className="mt-3 border-t border-border pt-2 text-[11px] text-muted-foreground">
                          {previewFooter}
                        </p>
                      ) : null}

                      <div className="mt-3 flex items-center justify-between text-[10px] text-muted-foreground">
                        <span>{templateName || "template_name"}</span>
                        <span>{language}</span>
                      </div>
                    </div>

                    <div className="mt-4 rounded-lg border border-border bg-card px-4 py-3 text-[11px] text-muted-foreground">
                      <p className="font-medium text-foreground">Variable preview</p>
                      <p className="mt-1">
                        Placeholders like {"{{1}}"} render as bracket markers such as <span className="font-semibold text-foreground">[1]</span> in the preview.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
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

function TemplateDetailBlock({
  label,
  value,
  preserveWhitespace = false,
}: {
  label: string;
  value: string;
  preserveWhitespace?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-secondary/30 p-4">
      <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </p>
      <p
        className={`text-sm leading-7 text-foreground ${
          preserveWhitespace ? "whitespace-pre-wrap" : ""
        }`}
      >
        {value}
      </p>
    </div>
  );
}
