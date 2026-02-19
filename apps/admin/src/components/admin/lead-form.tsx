"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const BUSINESS_TYPES = [
  "restaurant",
  "retail",
  "healthcare",
  "real_estate",
  "automotive",
  "professional_services",
  "salon_spa",
  "construction",
  "logistics",
  "other",
];

const SERVICES = [
  { value: "whatsapp_chatbot", label: "WhatsApp Chatbot" },
  { value: "website_chatbot", label: "Website Chatbot" },
  { value: "voice_agent", label: "AI Voice Agent" },
  { value: "custom_agent", label: "Custom AI Agent" },
];

const SOURCES = [
  { value: "website", label: "Website Form" },
  { value: "facebook", label: "Facebook" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "cold_email", label: "Cold Email" },
  { value: "referral", label: "Referral" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "walk_in", label: "Walk-in" },
];

const STATUSES = ["new", "contacted", "interested", "quoted", "won", "lost"];

interface LeadData {
  id?: string;
  businessName: string;
  contactPerson: string;
  phone: string;
  email: string;
  businessType: string;
  services: string[];
  description: string;
  source: string;
  status: string;
  quoteAmount: number | null;
  followUpDate: string;
}

export default function LeadForm({ initialData }: { initialData?: LeadData }) {
  const router = useRouter();
  const isEdit = !!initialData?.id;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [form, setForm] = useState<LeadData>({
    businessName: initialData?.businessName || "",
    contactPerson: initialData?.contactPerson || "",
    phone: initialData?.phone || "",
    email: initialData?.email || "",
    businessType: initialData?.businessType || "other",
    services: initialData?.services || [],
    description: initialData?.description || "",
    source: initialData?.source || "facebook",
    status: initialData?.status || "new",
    quoteAmount: initialData?.quoteAmount || null,
    followUpDate: initialData?.followUpDate || "",
  });

  const toggleService = (value: string) => {
    setForm((prev) => ({
      ...prev,
      services: prev.services.includes(value)
        ? prev.services.filter((s) => s !== value)
        : [...prev.services, value],
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const body = {
        ...form,
        quoteAmount: form.quoteAmount || null,
        followUpDate: form.followUpDate || null,
      };

      const url = isEdit ? `/api/leads/${initialData!.id}` : "/api/leads";
      const method = isEdit ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save");
      }

      const lead = await res.json();
      router.push(`/leads/${lead.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="bg-danger/10 text-danger text-sm px-4 py-3 rounded-lg border border-danger/20">
          {error}
        </div>
      )}

      <div className="bg-surface-raised rounded-xl border border-border p-6 space-y-4">
        <h2 className="font-semibold text-text">Contact Information</h2>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-text-muted mb-1">
              Business Name *
            </label>
            <input
              type="text"
              required
              value={form.businessName}
              onChange={(e) => setForm({ ...form, businessName: e.target.value })}
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-muted mb-1">
              Contact Person *
            </label>
            <input
              type="text"
              required
              value={form.contactPerson}
              onChange={(e) => setForm({ ...form, contactPerson: e.target.value })}
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-muted mb-1">
              Phone *
            </label>
            <input
              type="tel"
              required
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-muted mb-1">
              Email *
            </label>
            <input
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
        </div>
      </div>

      <div className="bg-surface-raised rounded-xl border border-border p-6 space-y-4">
        <h2 className="font-semibold text-text">Business Details</h2>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-text-muted mb-1">
              Business Type
            </label>
            <select
              value={form.businessType}
              onChange={(e) => setForm({ ...form, businessType: e.target.value })}
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              {BUSINESS_TYPES.map((t) => (
                <option key={t} value={t} className="capitalize">
                  {t.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-muted mb-1">
              Source
            </label>
            <select
              value={form.source}
              onChange={(e) => setForm({ ...form, source: e.target.value })}
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              {SOURCES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-text-muted mb-2">
            Services Interested
          </label>
          <div className="flex flex-wrap gap-2">
            {SERVICES.map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => toggleService(s.value)}
                className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
                  form.services.includes(s.value)
                    ? "bg-primary text-white border-primary"
                    : "bg-surface text-text-muted border-border hover:border-border-light"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-text-muted mb-1">
            Description
          </label>
          <textarea
            rows={3}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
            placeholder="Notes about what the client needs..."
          />
        </div>
      </div>

      <div className="bg-surface-raised rounded-xl border border-border p-6 space-y-4">
        <h2 className="font-semibold text-text">Lead Management</h2>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-text-muted mb-1">
              Status
            </label>
            <select
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s} className="capitalize">
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-muted mb-1">
              Quote Amount (R)
            </label>
            <input
              type="number"
              value={form.quoteAmount || ""}
              onChange={(e) =>
                setForm({
                  ...form,
                  quoteAmount: e.target.value ? Number(e.target.value) : null,
                })
              }
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
              placeholder="e.g. 2500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-muted mb-1">
              Follow-up Date
            </label>
            <input
              type="date"
              value={form.followUpDate}
              onChange={(e) => setForm({ ...form, followUpDate: e.target.value })}
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
        </div>
      </div>

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={loading}
          className="bg-primary hover:bg-primary-dark text-white px-6 py-2.5 rounded-lg font-medium transition-colors disabled:opacity-50"
        >
          {loading ? "Saving..." : isEdit ? "Update Lead" : "Create Lead"}
        </button>
        <button
          type="button"
          onClick={() => router.back()}
          className="text-text-muted hover:text-text px-6 py-2.5 rounded-lg font-medium"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
