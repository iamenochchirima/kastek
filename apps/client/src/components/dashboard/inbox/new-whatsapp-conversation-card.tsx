"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type ConnectionView = {
  id: string;
  phoneNumberId: string;
  phoneDisplayNumber: string | null;
};

type TemplateView = {
  id: string;
  templateName: string;
  language: string;
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION";
  status: "APPROVED" | "PENDING" | "REJECTED" | "DISABLED";
  variablesCount: number;
  body: string | null;
  connectionId: string | null;
};

const STEPS = [
  { id: 1, label: "Recipient" },
  { id: 2, label: "Template" },
  { id: 3, label: "Review" },
] as const;

const STATUS_STYLES: Record<TemplateView["status"], string> = {
  APPROVED: "border-green-500/30 bg-green-500/10 text-green-300",
  PENDING: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  REJECTED: "border-red-500/30 bg-red-500/10 text-red-300",
  DISABLED: "border-zinc-500/30 bg-zinc-500/10 text-zinc-300",
};

function renderPreview(body: string | null, parameters: string[]) {
  if (!body) return "Template preview will appear here.";

  return body.replace(/{{(\d+)}}/g, (_, token) => {
    const index = Number(token) - 1;
    return parameters[index] || `[${token}]`;
  });
}

function categoryLabel(category: TemplateView["category"]) {
  if (category === "AUTHENTICATION") return "Authentication";
  if (category === "UTILITY") return "Utility";
  return "Marketing";
}

export default function NewWhatsappConversationCard({
  connections,
  templates,
}: {
  connections: ConnectionView[];
  templates: TemplateView[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [connectionId, setConnectionId] = useState(connections[0]?.id || "");
  const [templateId, setTemplateId] = useState("");
  const [phone, setPhone] = useState("");
  const [contactLabel, setContactLabel] = useState("");
  const [bodyParameters, setBodyParameters] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const availableTemplates = useMemo(
    () =>
      templates.filter(
        (template) => !connectionId || !template.connectionId || template.connectionId === connectionId
      ),
    [connectionId, templates]
  );

  const selectedTemplate = availableTemplates.find((template) => template.id === templateId) || null;
  const readyForStepTwo = Boolean(connectionId && phone.trim());
  const readyForStepThree = Boolean(selectedTemplate && selectedTemplate.status === "APPROVED");

  function resetFlow() {
    setStep(1);
    setTemplateModalOpen(false);
    setTemplateId("");
    setPhone("");
    setContactLabel("");
    setBodyParameters([]);
    setError("");
  }

  function updateParameter(index: number, value: string) {
    setBodyParameters((current) => {
      const next = Array.from(
        { length: selectedTemplate?.variablesCount || 0 },
        (_, currentIndex) => current[currentIndex] || ""
      );
      next[index] = value;
      return next;
    });
  }

  function chooseTemplate(template: TemplateView) {
    setTemplateId(template.id);
    setBodyParameters(Array.from({ length: template.variablesCount }, () => ""));
    setTemplateModalOpen(false);

    if (template.status === "APPROVED") {
      setStep(3);
    }
  }

  async function startConversation() {
    setSubmitting(true);
    setError("");

    try {
      const res = await fetch("/api/whatsapp/inbox/conversations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          connectionId,
          templateId,
          phone,
          customerName: contactLabel || undefined,
          bodyParameters,
        }),
      });
      const payload = await res.json();

      if (!res.ok) {
        throw new Error(payload.error || "Failed to start conversation");
      }

      router.push(`/dashboard/inbox/whatsapp/${payload.conversationId}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start conversation");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-text">Start new WhatsApp conversation</h2>
          <p className="text-sm text-text-muted">
            New business-initiated chats must begin with an approved template.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setOpen((current) => {
              const next = !current;
              if (!next) resetFlow();
              return next;
            });
          }}
          className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-bg"
        >
          {open ? "Close" : "New conversation"}
        </button>
      </div>

      {open ? (
        <div className="mt-5 space-y-5">
          <div className="grid gap-3 md:grid-cols-3">
            {STEPS.map((item) => {
              const active = item.id === step;
              const complete = item.id < step;
              return (
                <div
                  key={item.id}
                  className={`rounded-xl border px-4 py-3 ${
                    active
                      ? "border-accent bg-accent/10"
                      : complete
                        ? "border-green-500/30 bg-green-500/10"
                        : "border-border bg-surface-2"
                  }`}
                >
                  <p className="text-[11px] uppercase tracking-[0.18em] text-text-dim">
                    Step {item.id}
                  </p>
                  <p className="mt-1 text-sm font-semibold text-text">{item.label}</p>
                </div>
              );
            })}
          </div>

          {error ? (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          ) : null}

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_360px]">
            <div className="space-y-4">
              {step === 1 ? (
                <div className="space-y-4 rounded-xl border border-border bg-surface-2 p-4">
                  <div>
                    <h3 className="text-base font-semibold text-text">Who are you messaging?</h3>
                    <p className="mt-1 text-sm text-text-muted">
                      Choose the sending number and enter the recipient’s WhatsApp number.
                    </p>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="space-y-2 text-sm">
                      <span className="text-text-muted">Connection</span>
                      <select
                        value={connectionId}
                        onChange={(event) => {
                          setConnectionId(event.target.value);
                          setTemplateId("");
                          setBodyParameters([]);
                        }}
                        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-text"
                      >
                        {connections.map((connection) => (
                          <option key={connection.id} value={connection.id}>
                            {connection.phoneDisplayNumber || connection.phoneNumberId}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="space-y-2 text-sm">
                      <span className="text-text-muted">Recipient phone</span>
                      <input
                        value={phone}
                        onChange={(event) => setPhone(event.target.value)}
                        placeholder="+27 76 123 4567"
                        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-text"
                      />
                    </label>
                  </div>

                  <label className="space-y-2 text-sm">
                    <span className="text-text-muted">Contact label (optional)</span>
                    <input
                      value={contactLabel}
                      onChange={(event) => setContactLabel(event.target.value)}
                      placeholder="Internal label for this thread, e.g. Jane Doe"
                      className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-text"
                    />
                    <p className="text-xs text-text-dim">
                      This is just how the contact will appear in your inbox. It is not sent to the
                      customer.
                    </p>
                  </label>

                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => setStep(2)}
                      disabled={!readyForStepTwo}
                      className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-bg disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Continue to templates
                    </button>
                  </div>
                </div>
              ) : null}

              {step === 2 ? (
                <div className="space-y-4 rounded-xl border border-border bg-surface-2 p-4">
                  <div>
                    <h3 className="text-base font-semibold text-text">Choose a template</h3>
                    <p className="mt-1 text-sm text-text-muted">
                      Open the template library to see approved, pending, and rejected templates for
                      this number.
                    </p>
                  </div>

                  <div className="rounded-xl border border-border bg-surface p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-text">
                          {selectedTemplate ? selectedTemplate.templateName : "No template selected"}
                        </p>
                        <p className="mt-1 text-xs text-text-dim">
                          {selectedTemplate
                            ? `${categoryLabel(selectedTemplate.category)} · ${selectedTemplate.language} · ${selectedTemplate.status.toLowerCase()}`
                            : "Select a template from the modal"}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setTemplateModalOpen(true)}
                        className="rounded-lg border border-border px-4 py-2 text-sm text-text hover:border-border-light"
                      >
                        Open template library
                      </button>
                    </div>
                  </div>

                  <div className="flex justify-between">
                    <button
                      type="button"
                      onClick={() => setStep(1)}
                      className="rounded-lg border border-border px-4 py-2 text-sm text-text hover:border-border-light"
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      onClick={() => setStep(3)}
                      disabled={!readyForStepThree}
                      className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-bg disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Continue to review
                    </button>
                  </div>
                </div>
              ) : null}

              {step === 3 ? (
                <div className="space-y-4 rounded-xl border border-border bg-surface-2 p-4">
                  <div>
                    <h3 className="text-base font-semibold text-text">Review and send</h3>
                    <p className="mt-1 text-sm text-text-muted">
                      Confirm the template, fill any required variables, and start the conversation.
                    </p>
                  </div>

                  <div className="rounded-xl border border-border bg-surface p-4 text-sm">
                    <div className="grid gap-3 md:grid-cols-2">
                      <div>
                        <p className="text-xs uppercase tracking-[0.15em] text-text-dim">Recipient</p>
                        <p className="mt-1 text-text">{phone}</p>
                        {contactLabel ? (
                          <p className="mt-1 text-xs text-text-dim">Label: {contactLabel}</p>
                        ) : null}
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-[0.15em] text-text-dim">Template</p>
                        <p className="mt-1 text-text">
                          {selectedTemplate
                            ? `${selectedTemplate.templateName} · ${categoryLabel(selectedTemplate.category)}`
                            : "No template selected"}
                        </p>
                      </div>
                    </div>
                  </div>

                  {selectedTemplate?.variablesCount ? (
                    <div className="grid gap-3 md:grid-cols-2">
                      {Array.from({ length: selectedTemplate.variablesCount }, (_, index) => (
                        <label key={index} className="space-y-2 text-sm">
                          <span className="text-text-muted">Variable {index + 1}</span>
                          <input
                            value={bodyParameters[index] || ""}
                            onChange={(event) => updateParameter(index, event.target.value)}
                            placeholder={`Value for {{${index + 1}}}`}
                            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-text"
                          />
                        </label>
                      ))}
                    </div>
                  ) : null}

                  <div className="flex justify-between">
                    <button
                      type="button"
                      onClick={() => setStep(2)}
                      className="rounded-lg border border-border px-4 py-2 text-sm text-text hover:border-border-light"
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      onClick={startConversation}
                      disabled={submitting || !readyForStepThree}
                      className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-bg disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {submitting ? "Sending..." : "Send template"}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="rounded-3xl border border-border bg-[#d7e3c6] shadow-[0_20px_60px_rgba(0,0,0,0.18)]">
              <div className="border-b border-black/5 bg-[#e6efda] px-4 py-3">
                <p className="text-sm font-semibold text-slate-900">Message Preview</p>
                <p className="text-[11px] text-slate-600">
                  {selectedTemplate
                    ? `${selectedTemplate.templateName} · ${selectedTemplate.status.toLowerCase()}`
                    : "Select a template to preview"}
                </p>
              </div>

              <div className="bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.65),_transparent_34%),linear-gradient(180deg,_#dfead0_0%,_#cadab8_100%)] p-4">
                <div className="ml-auto max-w-[280px] rounded-[20px] rounded-tr-md bg-[#f6f1df] px-4 py-3 shadow-[0_8px_24px_rgba(0,0,0,0.08)]">
                  <p className="whitespace-pre-wrap text-[13px] leading-6 text-slate-800">
                    {selectedTemplate
                      ? renderPreview(selectedTemplate.body, bodyParameters)
                      : "Approved template content will appear here."}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {templateModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="max-h-[85vh] w-full max-w-4xl overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <h3 className="text-lg font-semibold text-text">Template library</h3>
                <p className="text-sm text-text-muted">
                  Approved templates can be selected now. Pending or rejected ones are visible for
                  reference only.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setTemplateModalOpen(false)}
                className="rounded-lg border border-border px-3 py-2 text-sm text-text"
              >
                Close
              </button>
            </div>

            <div className="grid max-h-[calc(85vh-81px)] gap-4 overflow-y-auto p-5 md:grid-cols-2">
              {availableTemplates.map((template) => {
                const selectable = template.status === "APPROVED";
                const selected = template.id === templateId;

                return (
                  <div
                    key={template.id}
                    className={`rounded-xl border p-4 ${
                      selected ? "border-accent bg-accent/10" : "border-border bg-surface-2"
                    }`}
                  >
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-text">{template.templateName}</p>
                        <p className="mt-1 text-xs text-text-dim">
                          {categoryLabel(template.category)} · {template.language}
                        </p>
                      </div>
                      <span className={`rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.15em] ${STATUS_STYLES[template.status]}`}>
                        {template.status}
                      </span>
                    </div>

                    <p className="mb-4 line-clamp-4 text-sm text-text-muted">
                      {template.body || "No body preview available."}
                    </p>

                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs text-text-dim">
                        {template.variablesCount} variable
                        {template.variablesCount === 1 ? "" : "s"}
                      </p>
                      <button
                        type="button"
                        onClick={() => chooseTemplate(template)}
                        disabled={!selectable}
                        className="rounded-lg border border-border px-3 py-2 text-sm text-text disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {selectable ? (selected ? "Selected" : "Use template") : "Not selectable"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
