import { apiUrl } from "@/lib/server-api";
import { useEffect, useRef, useState } from "react";
import { useRevalidator, useSearchParams } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Plus, RotateCcw, Search, X } from "@/components/ui/interface-icons";
import "./whatsapp-template-manager.css";
import { Textarea } from "@/components/ui/textarea";
import {
  TEMPLATE_CATEGORY_OPTIONS,
  TEMPLATE_LIBRARY,
  categoryLabel,
  type TemplateCategoryValue,
} from "@/lib/whatsapp/template-library";

export type TemplateView = {
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
  connectionId?: string;
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

export default function WhatsappTemplateManager({ templates, connections, initialLibraryItemId, forceCreateForm = false, initialStatus = "all", templatesError, connectionsError }: {
  templates: TemplateView[]; connections: ConnectionView[]; initialLibraryItemId?: string; forceCreateForm?: boolean;
  initialStatus?: string; templatesError?: string | null; connectionsError?: string | null;
}) {
  const revalidator = useRevalidator();
  const [, setSearchParams] = useSearchParams();
  const [connectionId, setConnectionId] = useState(connections[0]?.id || "");
  const [templateName, setTemplateName] = useState("");
  const [language, setLanguage] = useState("en_US");
  const [category, setCategory] = useState<TemplateCategoryValue>("MARKETING");
  const [header, setHeader] = useState("");
  const [body, setBody] = useState("");
  const [footer, setFooter] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(forceCreateForm || Boolean(initialLibraryItemId));
  const [submitting, setSubmitting] = useState(false);
  const submitLock = useRef(false);
  const syncLock = useRef(false);
  const [attempted, setAttempted] = useState(false);
  const [syncingConnectionId, setSyncingConnectionId] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState(initialStatus);
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [languageFilter, setLanguageFilter] = useState("all");
  const [accountFilter, setAccountFilter] = useState("all");
  const [syncAccount, setSyncAccount] = useState(connections[0]?.id || "");
  const [desktop, setDesktop] = useState(() => typeof window !== "undefined" && window.matchMedia("(min-width: 1280px)").matches);
  const opener = useRef<HTMLElement | null>(null);
  const previewOpener = useRef<HTMLElement | null>(null);
  const activeConnection = connections.find(connection => connection.id === connectionId);
  const selectedTemplate = templates.find(template => template.id === selectedTemplateId) || null;
  const variablePlacementError = getVariablePlacementError({ header, body, footer });
  const nameError = attempted && !templateName.trim() ? "Enter a template name" : "";
  const bodyError = attempted && !body.trim() ? "Enter a message" : "";
  const placementError = attempted ? variablePlacementError : "";
  const scoped = templates.filter(template => (!query || `${template.templateName} ${template.body || ""}`.toLowerCase().includes(query.toLowerCase())) && (categoryFilter === "all" || template.category === categoryFilter) && (languageFilter === "all" || template.language === languageFilter) && (accountFilter === "all" || template.connectionId === accountFilter));
  const filtered = scoped.filter(template => status === "all" || template.status === status);
  useEffect(() => { setStatus(initialStatus); }, [initialStatus]);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1280px)");
    const update = () => setDesktop(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!connections.some(connection => connection.id === connectionId)) setConnectionId(connections[0]?.id || "");
    if (!connections.some(connection => connection.id === syncAccount)) setSyncAccount(connections[0]?.id || "");
  }, [connections, connectionId, syncAccount]);
  useEffect(() => {
    if (!initialLibraryItemId) return;
    const starter = TEMPLATE_LIBRARY.find(item => item.id === initialLibraryItemId);
    if (!starter) return;
    setCategory(starter.category); setHeader(starter.header || ""); setBody(starter.body); setFooter(starter.footer || "");
    setTemplateName(current => current || starter.title.toLowerCase().replace(/[^a-z0-9_]+/g, "_"));
    setShowCreateForm(true);
  }, [initialLibraryItemId]);
  useEffect(() => { if (forceCreateForm) setShowCreateForm(true); }, [forceCreateForm]);
  function openCreate(event: React.MouseEvent<HTMLButtonElement>) { opener.current = event.currentTarget; setShowCreateForm(true); }
  function changeStatus(next: string) {
    setStatus(next);
    setSearchParams(previous => { const params = new URLSearchParams(previous); if (next === "all") params.delete("status"); else params.set("status", next); return params; }, { replace: true });
  }
  function closeCreate(open: boolean) {
    if (submitting) return;
    setShowCreateForm(open);
    if (!open) setSearchParams(previous => { const params = new URLSearchParams(previous); params.delete("create"); params.delete("starter"); return params; }, { replace: true });
  }
  async function handleCreateTemplate(event: React.FormEvent) {
    event.preventDefault(); setAttempted(true); setError("");
    if (submitLock.current || !templateName.trim() || !body.trim() || variablePlacementError || !connectionId) return;
    submitLock.current = true; setSubmitting(true);
    try {
      const res = await fetch(apiUrl("/api/whatsapp/templates"), { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connectionId, templateName, language, category, header: header || undefined, body, footer: footer || undefined }) });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || "Template submission failed");
      toast.success(payload.status === "APPROVED" ? "Template approved" : "Template submitted");
      setTemplateName(""); setHeader(""); setBody(""); setFooter(""); setCategory("MARKETING"); setAttempted(false); setShowCreateForm(false);
      setSearchParams(previous => { const params = new URLSearchParams(previous); params.delete("create"); params.delete("starter"); return params; }, { replace: true });
      void revalidator.revalidate();
    } catch (err) { setError(err instanceof Error ? err.message : "Template submission failed"); }
    finally { submitLock.current = false; setSubmitting(false); }
  }
  async function handleSync() {
    if (syncLock.current || !syncAccount) return;
    syncLock.current = true; setSyncingConnectionId(syncAccount); setSyncError("");
    try {
      const res = await fetch(apiUrl(`/api/whatsapp/connections/${syncAccount}/templates/sync`), { method: "POST", credentials: "include" });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || "Template sync failed");
      toast.success("Templates synced", typeof payload.synced === "number" ? { description: `${payload.synced} templates updated` } : undefined);
      void revalidator.revalidate();
    } catch (err) { setSyncError(err instanceof Error ? err.message : "Template sync failed"); }
    finally { syncLock.current = false; setSyncingConnectionId(null); }
  }
  const preview = selectedTemplate ? <TemplatePreview template={selectedTemplate} /> : null;
  return <div className="templates-workspace">
    <header className="templates-header"><h1>Templates</h1><div className="templates-actions">
      {connections.length > 1 && <FilterSelect label="Sync account" value={syncAccount} onChange={setSyncAccount} options={connections.map(connection => ({ value: connection.id, label: connection.phoneDisplayNumber || connection.phoneNumberId }))} />}
      <Button variant="outline" onClick={handleSync} disabled={!syncAccount || Boolean(syncingConnectionId)}><RotateCcw className={syncingConnectionId ? "size-4 animate-spin" : "size-4"} />{syncingConnectionId ? "Syncing…" : "Sync templates"}</Button>
      <Button onClick={openCreate} disabled={!connections.length}><Plus className="size-4" />New template</Button>
    </div></header>
    {templatesError && <div role="alert" className="templates-alert">{templatesError}<Button variant="outline" size="sm" onClick={() => revalidator.revalidate()}>Retry templates</Button></div>}
    {connectionsError && <div role="alert" className="templates-alert">{connectionsError}<Button variant="outline" size="sm" onClick={() => revalidator.revalidate()}>Retry accounts</Button></div>}
    {syncError && <div role="alert" className="templates-alert">{syncError}<Button variant="outline" size="sm" onClick={handleSync}>Retry sync</Button></div>}
    <div className={selectedTemplate && desktop ? "templates-layout has-preview" : "templates-layout"}><section className="templates-library" aria-label="Template library">
      <nav className="templates-tabs" aria-label="Template status">{(["all", "APPROVED", "PENDING", "REJECTED", "DISABLED"] as const).map(value => <button key={value} aria-current={status === value ? "page" : undefined} onClick={() => changeStatus(value)}>{value === "all" ? "All templates" : statusLabel(value)}<span>{scoped.filter(template => value === "all" || template.status === value).length}</span></button>)}</nav>
      <div className="templates-toolbar"><label className="templates-search"><Search className="size-4" /><Input aria-label="Search templates" placeholder="Search templates…" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <FilterSelect label="Category" value={categoryFilter} onChange={setCategoryFilter} options={[{ value: "all", label: "All categories" }, ...TEMPLATE_CATEGORY_OPTIONS.map(option => ({ value: option.value, label: option.label }))]} />
        <FilterSelect label="Language" value={languageFilter} onChange={setLanguageFilter} options={[{ value: "all", label: "All languages" }, ...Array.from(new Set(templates.map(template => template.language))).map(value => ({ value, label: languageLabel(value) }))]} />
        <FilterSelect label="Account" value={accountFilter} onChange={setAccountFilter} options={[{ value: "all", label: "All accounts" }, ...connections.map(connection => ({ value: connection.id, label: connection.phoneDisplayNumber || connection.phoneNumberId }))]} />
      </div>
      {!templatesError && !filtered.length ? <div className="templates-empty"><h2>{templates.length ? "No matching templates" : "No templates yet"}</h2>{!connections.length && !connectionsError ? <Button variant="outline" asChild><a href="/connections">Connect WhatsApp</a></Button> : !templates.length && connections.length > 0 ? <Button onClick={openCreate}>Create new template</Button> : null}</div> : <>
        <div className="templates-table-scroll"><table className="templates-table"><thead><tr><th scope="col">Template</th><th scope="col">Category</th><th scope="col">Language</th><th scope="col">Account</th><th scope="col">Status</th><th scope="col">Last synced</th></tr></thead><tbody>{filtered.map(template => <tr key={template.id} data-selected={selectedTemplateId === template.id || undefined}><td><button className="template-name" aria-label={`Preview ${template.templateName}`} onClick={event => { previewOpener.current = event.currentTarget; setSelectedTemplateId(template.id); }}>{template.templateName}</button><p className="template-excerpt">{template.body || "—"}</p></td><td>{categoryLabel(template.category)}</td><td>{languageLabel(template.language)}</td><td>{template.connectionLabel || "—"}</td><td><StatusBadge status={template.status} /></td><td className="templates-date">{formatDate(template.lastSynced)}</td></tr>)}</tbody></table></div>
        <div className="templates-mobile-list">{filtered.map(template => <button key={template.id} onClick={event => { previewOpener.current = event.currentTarget; setSelectedTemplateId(template.id); }} aria-label={`Preview ${template.templateName}`}><span className="templates-mobile-heading"><strong>{template.templateName}</strong><StatusBadge status={template.status} /></span><span className="template-excerpt">{template.body || "—"}</span><span className="templates-mobile-meta">{categoryLabel(template.category)} · {languageLabel(template.language)} · {template.connectionLabel || "—"}</span></button>)}</div>
      </>}
      <p className="templates-count">{filtered.length} {filtered.length === 1 ? "template" : "templates"}{revalidator.state !== "idle" ? " · Refreshing…" : ""}</p>
    </section>
    {selectedTemplate && desktop && <aside className="templates-inspector" aria-label="Template preview"><div className="templates-inspector-heading"><h2>Template preview</h2><Button variant="ghost" size="icon" aria-label="Close template preview" onClick={() => setSelectedTemplateId(null)}><X className="size-4" /></Button></div>{preview}</aside>}
    </div>
    <Sheet open={Boolean(selectedTemplate) && !desktop} onOpenChange={open => { if (!open) setSelectedTemplateId(null); }}><SheetContent className="templates-preview-sheet" aria-describedby={undefined} onCloseAutoFocus={event => { event.preventDefault(); if (previewOpener.current?.isConnected) previewOpener.current.focus(); }}><SheetTitle>Template preview</SheetTitle>{preview}</SheetContent></Sheet>
    <Dialog open={showCreateForm} onOpenChange={closeCreate}><DialogContent showCloseButton={false} className="template-create-dialog" aria-describedby={undefined} onCloseAutoFocus={event => { event.preventDefault(); if (opener.current?.isConnected) opener.current.focus(); }} onEscapeKeyDown={event => { if (submitting) event.preventDefault(); }} onInteractOutside={event => { if (submitting) event.preventDefault(); }}>
      <form onSubmit={handleCreateTemplate} noValidate><div className="template-create-heading"><DialogTitle>Create template</DialogTitle><Button type="button" variant="ghost" size="icon" aria-label="Close creator" disabled={submitting} onClick={() => closeCreate(false)}><X className="size-4" /></Button></div>
        <div className="template-create-columns"><div className="template-create-fields">
          <label>Template name<Input aria-label="Template name" value={templateName} onChange={event => setTemplateName(event.target.value)} aria-invalid={Boolean(nameError)} aria-describedby={nameError ? "template-name-error" : undefined} />{nameError && <span id="template-name-error" className="template-field-error">{nameError}</span>}</label>
          <div><span className="template-field-label">Category</span><div className="template-category-options" role="group" aria-label="Template category">{TEMPLATE_CATEGORY_OPTIONS.map(option => <button key={option.value} type="button" aria-pressed={category === option.value} onClick={() => setCategory(option.value)}>{option.label}</button>)}</div></div>
          <div className="template-fields-pair"><div><span className="template-field-label">Account</span>{connections.length > 1 ? <FilterSelect label="Connection" value={connectionId} onChange={setConnectionId} options={connections.map(connection => ({ value: connection.id, label: connection.phoneDisplayNumber || connection.phoneNumberId }))} /> : <p className="template-single-account">{activeConnection?.phoneDisplayNumber || activeConnection?.phoneNumberId || "No account connected"}</p>}</div><div><span className="template-field-label">Language</span><FilterSelect label="Template language" value={language} onChange={setLanguage} options={LANGUAGE_OPTIONS} /></div></div>
          <label>Header <span className="template-optional">(optional)</span><Input aria-label="Header (optional)" value={header} onChange={event => setHeader(event.target.value)} aria-invalid={Boolean(placementError && hasLeadingOrTrailingVariable(header))} /></label>
          <label>Body<Textarea aria-label="Body" value={body} onChange={event => setBody(event.target.value)} rows={6} aria-invalid={Boolean(bodyError || (placementError && hasLeadingOrTrailingVariable(body)))} aria-describedby={bodyError ? "template-body-error" : undefined} />{bodyError && <span id="template-body-error" className="template-field-error">{bodyError}</span>}</label>
          <label>Footer <span className="template-optional">(optional)</span><Input aria-label="Footer (optional)" value={footer} onChange={event => setFooter(event.target.value)} aria-invalid={Boolean(placementError && hasLeadingOrTrailingVariable(footer))} /></label>
          {placementError && <p className="template-field-error" role="alert">{placementError}</p>}{error && <p className="template-field-error" role="alert">{error}</p>}
        </div><aside className="template-create-preview"><h3>Message preview</h3><MessagePreview header={header} body={body} footer={footer} /><p className="template-sample-label">Variables appear as [1], [2]…</p></aside></div>
        <footer className="template-create-footer"><Button type="button" variant="outline" disabled={submitting} onClick={() => closeCreate(false)}>Cancel</Button><Button type="submit" disabled={submitting || !connectionId}>{submitting ? "Submitting…" : "Submit template"}</Button></footer>
      </form>
    </DialogContent></Dialog>
  </div>;
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }> }) {
  return <Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label}><SelectValue /></SelectTrigger><SelectContent>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select>;
}
function statusLabel(status: TemplateView["status"]) { return status.charAt(0) + status.slice(1).toLowerCase(); }
function StatusBadge({ status }: { status: TemplateView["status"] }) { return <span className={`template-status ${STATUS_STYLES[status]}`}>{statusLabel(status)}</span>; }
function languageLabel(value: string) { return LANGUAGE_OPTIONS.find(option => option.value === value)?.label || value; }
function formatDate(value: string | null) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? "Unavailable" : date.toLocaleString("en-ZA", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }); }
function MessagePreview({ header, body, footer, buttons }: { header: string | null; body: string | null; footer: string | null; buttons?: unknown }) {
  const savedButtons = Array.isArray(buttons) ? buttons : typeof buttons === "object" && buttons && "buttons" in buttons && Array.isArray(buttons.buttons) ? buttons.buttons : [];
  return <div className="template-message-surface"><div className="template-message">{header && <strong>{renderPreviewText(header)}</strong>}<p>{renderPreviewText(body || "") || "Message preview"}</p>{footer && <small>{renderPreviewText(footer)}</small>}{savedButtons.map((button, index) => <div className="template-preview-button" key={index}>{typeof button === "object" && button && "text" in button && typeof button.text === "string" ? button.text : "Button"}</div>)}</div></div>;
}
function TemplatePreview({ template }: { template: TemplateView }) {
  return <div className="template-preview-content"><h3>{template.templateName}</h3><StatusBadge status={template.status} /><MessagePreview header={template.header} body={template.body} footer={template.footer} buttons={template.buttons} /><dl>{[["Category", categoryLabel(template.category)], ["Language", languageLabel(template.language)], ["Account", template.connectionLabel || "—"], ["Variables", String(template.variablesCount)], ["Last synced", formatDate(template.lastSynced)]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>{template.variablesCount > 0 && <p className="template-sample-label">[1], [2]… are sample markers.</p>}</div>;
}
