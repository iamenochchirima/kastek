"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  applyTemplateToDraft,
  formatQuotationDateInput,
  getServiceLabel,
  QUOTATION_SERVICE_TYPES,
  QUOTATION_STATUSES,
  type QuotationDraft,
} from "@/lib/quotation";

type Props = {
  mode: "create" | "edit";
  initialDraft: QuotationDraft;
};

type PricingItemState = {
  id: string;
  description: string;
  amount: string;
  billing: string;
};

function toTextAreaValue(items: string[]) {
  return items.join("\n");
}

function fromTextAreaValue(value: string) {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function createPricingItemId() {
  return `item_${Math.random().toString(36).slice(2, 10)}`;
}

function toPricingItemState(items: QuotationDraft["pricingItems"]): PricingItemState[] {
  return items.map((item) => ({
    id: createPricingItemId(),
    description: item.description,
    amount: item.amount,
    billing: item.billing,
  }));
}

export default function QuotationBuilder({ mode, initialDraft }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState(initialDraft);
  const [pricingItems, setPricingItems] = useState<PricingItemState[]>(
    toPricingItemState(initialDraft.pricingItems)
  );
  const [textAreas, setTextAreas] = useState({
    scopeOfWork: toTextAreaValue(initialDraft.scopeOfWork),
    deliverables: toTextAreaValue(initialDraft.deliverables),
    maintenanceIncludes: toTextAreaValue(initialDraft.maintenanceIncludes),
    termsAndNotes: toTextAreaValue(initialDraft.termsAndNotes),
  });

  const pdfUrl = useMemo(() => {
    if (!form.id) return null;
    return `/api/quotations/${form.id}/pdf`;
  }, [form.id]);

  useEffect(() => {
    if (mode !== "create") return;
    const localToday = formatQuotationDateInput(new Date());
    setForm((prev) => (prev.date === localToday ? prev : { ...prev, date: localToday }));
  }, [mode]);

  function syncListField<K extends keyof typeof textAreas>(key: K, value: string) {
    setTextAreas((prev) => ({ ...prev, [key]: value }));
    setForm((prev) => ({ ...prev, [key]: fromTextAreaValue(value) }));
  }

  function applyTemplate(serviceType: string) {
    const next = applyTemplateToDraft(form, serviceType);
    setForm(next);
    setPricingItems(toPricingItemState(next.pricingItems));
    setTextAreas({
      scopeOfWork: toTextAreaValue(next.scopeOfWork),
      deliverables: toTextAreaValue(next.deliverables),
      maintenanceIncludes: toTextAreaValue(next.maintenanceIncludes),
      termsAndNotes: toTextAreaValue(next.termsAndNotes),
    });
  }

  function updateLineItem(id: string, field: "description" | "amount" | "billing", value: string) {
    setPricingItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, [field]: value } : item))
    );
  }

  function addLineItem() {
    setPricingItems((prev) => [
      ...prev,
      { id: createPricingItemId(), description: "", amount: "", billing: "Once-off" },
    ]);
  }

  function removeLineItem(id: string) {
    setPricingItems((prev) => prev.filter((item) => item.id !== id));
  }

  async function saveQuotation(nextStatus?: string) {
    setLoading(true);
    setError("");

    const payload = {
      quoteRequestId: form.quoteRequestId || null,
      serviceType: form.serviceType,
      businessName: form.preparedFor,
      contactPerson: form.contactPerson,
      contactEmail: form.contactEmail,
      contactPhone: form.contactPhone,
      date: form.date,
      title: form.title,
      introduction: form.introduction,
      scopeOfWork: form.scopeOfWork,
      deliverables: form.deliverables,
      implementationSteps: [],
      pricingItems: pricingItems.map(({ description, amount, billing }) => ({
        description,
        amount,
        billing,
      })),
      maintenanceIncludes: form.maintenanceIncludes,
      termsAndNotes: form.termsAndNotes,
      validityDays: form.validityDays,
      status: nextStatus || form.status,
    };

    try {
      const url = mode === "create" ? "/api/quotations" : `/api/quotations/${form.id}`;
      const method = mode === "create" ? "POST" : "PATCH";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save quotation");

      if (mode === "create") {
        router.push(`/quotations/${data.id}`);
      } else {
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save quotation");
    } finally {
      setLoading(false);
    }
  }

  async function deleteQuotation() {
    if (!form.id) return;
    setDeleting(true);
    setError("");

    const res = await fetch(`/api/quotations/${form.id}`, { method: "DELETE" });
    if (res.ok) {
      router.push("/quotations");
      router.refresh();
      return;
    }

    setDeleting(false);
    setError("Failed to delete quotation");
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-danger/10 text-danger text-sm px-4 py-3 rounded-lg border border-danger/20">
          {error}
        </div>
      )}

      <div className="bg-surface-raised rounded-xl border border-border p-6 space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-semibold text-text">Quotation Builder</h2>
            <p className="text-sm text-text-muted">
              Build a professional quotation with service-specific sections, line items, and PDF output.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {pdfUrl && (
              <a
                href={pdfUrl}
                target="_blank"
                rel="noreferrer"
                className="border border-border hover:bg-surface-overlay px-4 py-2 rounded-lg text-sm font-medium text-text transition-colors whitespace-nowrap"
              >
                Download PDF
              </a>
            )}
            <button
              type="button"
              onClick={() => saveQuotation()}
              disabled={loading}
              className="bg-primary hover:bg-primary-dark text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 whitespace-nowrap"
            >
              {loading ? "Saving..." : mode === "create" ? "Create Quotation" : "Save Changes"}
            </button>
          </div>
        </div>

        <div className="grid md:grid-cols-[1.2fr_auto] gap-4 items-end border border-border rounded-xl p-4">
          <div>
            <label className="block text-sm font-medium text-text-muted mb-1">Quotation Type</label>
            <select
              value={form.serviceType}
              onChange={(e) => setForm({ ...form, serviceType: e.target.value })}
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              {QUOTATION_SERVICE_TYPES.map((service) => (
                <option key={service.value} value={service.value}>
                  {service.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-text-faint mt-1">
              Current template: {getServiceLabel(form.serviceType)}
            </p>
          </div>
          <button
            type="button"
            onClick={() => applyTemplate(form.serviceType)}
            className="border border-border hover:bg-surface-overlay px-4 py-2 rounded-lg text-sm font-medium text-text transition-colors"
          >
            Apply Service Template
          </button>
        </div>

        {mode === "edit" && (
          <div className="flex items-center justify-between gap-4 border border-border rounded-xl px-4 py-3">
            <div>
              <p className="text-sm font-medium text-text">Quotation Status</p>
              <p className="text-xs text-text-faint">
                Track whether the quotation is draft, sent, accepted, rejected, or expired.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 justify-end">
              {QUOTATION_STATUSES.map((status) => (
                <button
                  key={status.value}
                  type="button"
                  onClick={() => {
                    setForm({ ...form, status: status.value });
                    void saveQuotation(status.value);
                  }}
                  disabled={loading}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                    status.value === form.status
                      ? "bg-primary/15 text-primary ring-2 ring-offset-1 ring-offset-surface-raised ring-primary/50"
                      : "bg-surface-overlay text-text-faint hover:text-text-muted hover:bg-border"
                  }`}
                >
                  {status.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="bg-surface border border-border rounded-xl p-5 space-y-4">
          <h3 className="font-semibold text-text">Prepared For</h3>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-muted mb-1">Client Business Name</label>
              <input
                type="text"
                value={form.preparedFor}
                onChange={(e) => setForm({ ...form, preparedFor: e.target.value })}
                className="w-full px-3 py-2 bg-surface-2 border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-muted mb-1">Date</label>
              <input
                type="text"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
                placeholder="YYYY-MM-DD"
                className="w-full px-3 py-2 bg-surface-2 border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
              <p className="text-xs text-text-faint mt-1">Use format `YYYY-MM-DD`.</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-text-muted mb-1">Client Contact Email</label>
              <input
                type="email"
                value={form.contactEmail}
                onChange={(e) => setForm({ ...form, contactEmail: e.target.value })}
                className="w-full px-3 py-2 bg-surface-2 border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-muted mb-1">Quotation Title</label>
              <input
                type="text"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                className="w-full px-3 py-2 bg-surface-2 border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
          </div>
        </div>

        <div className="bg-surface border border-border rounded-xl p-5 space-y-4">
          <h3 className="font-semibold text-text">Project Summary</h3>
          <textarea
            rows={4}
            value={form.introduction}
            onChange={(e) => setForm({ ...form, introduction: e.target.value })}
            className="w-full px-3 py-2 bg-surface-2 border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <div className="bg-surface border border-border rounded-xl p-5 space-y-3">
            <h3 className="font-semibold text-text">Included in Service</h3>
            <textarea
              rows={8}
              value={textAreas.scopeOfWork}
              onChange={(e) => syncListField("scopeOfWork", e.target.value)}
              className="w-full px-3 py-2 bg-surface-2 border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <p className="text-xs text-text-faint">Use one line per included service item.</p>
          </div>

          <div className="bg-surface border border-border rounded-xl p-5 space-y-3">
            <h3 className="font-semibold text-text">Assistant Features</h3>
            <textarea
              rows={8}
              value={textAreas.deliverables}
              onChange={(e) => syncListField("deliverables", e.target.value)}
              className="w-full px-3 py-2 bg-surface-2 border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <p className="text-xs text-text-faint">Describe what the assistant will actually do for the client.</p>
          </div>

          <div className="bg-surface border border-border rounded-xl p-5 space-y-3">
            <h3 className="font-semibold text-text">Monthly Maintenance</h3>
            <textarea
              rows={8}
              value={textAreas.maintenanceIncludes}
              onChange={(e) => syncListField("maintenanceIncludes", e.target.value)}
              className="w-full px-3 py-2 bg-surface-2 border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <p className="text-xs text-text-faint">Use one line per included monthly support item.</p>
          </div>
        </div>

        <div className="bg-surface border border-border rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-text">Pricing Items</h3>
            <button
              type="button"
              onClick={addLineItem}
              className="border border-border hover:bg-surface-overlay px-3 py-2 rounded-lg text-sm font-medium text-text transition-colors"
            >
              + Add Line Item
            </button>
          </div>

          <div className="space-y-3">
            {pricingItems.map((item) => (
              <div key={item.id} className="grid md:grid-cols-[1.8fr_1fr_1fr_auto] gap-3">
                <input
                  type="text"
                  value={item.description}
                  onChange={(e) => updateLineItem(item.id, "description", e.target.value)}
                  placeholder="Description"
                  className="px-3 py-2 bg-surface-2 border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                <input
                  type="text"
                  value={item.amount}
                  onChange={(e) => updateLineItem(item.id, "amount", e.target.value)}
                  placeholder="Amount"
                  className="px-3 py-2 bg-surface-2 border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                <input
                  type="text"
                  value={item.billing}
                  onChange={(e) => updateLineItem(item.id, "billing", e.target.value)}
                  placeholder="Billing"
                  className="px-3 py-2 bg-surface-2 border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                <button
                  type="button"
                  onClick={() => removeLineItem(item.id)}
                  className="border border-red-500/30 text-red-400 hover:bg-red-500/10 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="grid md:grid-cols-[1.4fr_0.6fr] gap-4">
          <div className="bg-surface border border-border rounded-xl p-5 space-y-3">
            <h3 className="font-semibold text-text">Terms and Notes</h3>
            <textarea
              rows={8}
              value={textAreas.termsAndNotes}
              onChange={(e) => syncListField("termsAndNotes", e.target.value)}
              className="w-full px-3 py-2 bg-surface-2 border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <p className="text-xs text-text-faint">Use one line per term or note.</p>
          </div>

          <div className="bg-surface border border-border rounded-xl p-5 space-y-3">
            <h3 className="font-semibold text-text">Validity</h3>
            <div>
              <label className="block text-sm font-medium text-text-muted mb-1">Validity Days</label>
              <input
                type="text"
                value={form.validityDays}
                onChange={(e) => setForm({ ...form, validityDays: e.target.value })}
                className="w-full px-3 py-2 bg-surface-2 border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
          </div>
        </div>

        {mode === "edit" && (
          <div className="pt-2">
            <button
              type="button"
              onClick={deleteQuotation}
              disabled={deleting}
              className="border border-red-500/30 text-red-400 hover:bg-red-500/10 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            >
              {deleting ? "Deleting..." : "Delete Quotation"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
