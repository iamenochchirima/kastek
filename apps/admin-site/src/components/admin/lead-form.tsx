"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { buttonClassName } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

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
        <div role="alert" className="rounded-md border border-status-danger/25 bg-status-danger-soft px-4 py-3 text-sm text-status-danger">
          {error}
        </div>
      )}

      <div className="v-card space-y-4 p-[var(--density-card-padding)]">
        <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">Contact information</h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">
              Business Name *
            </label>
            <Input
              type="text"
              required
              value={form.businessName}
              onChange={(e) => setForm({ ...form, businessName: e.target.value })}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">
              Contact Person *
            </label>
            <Input
              type="text"
              required
              value={form.contactPerson}
              onChange={(e) => setForm({ ...form, contactPerson: e.target.value })}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">
              Phone *
            </label>
            <Input
              type="tel"
              required
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">
              Email *
            </label>
            <Input
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </div>
        </div>
      </div>

      <div className="v-card space-y-4 p-[var(--density-card-padding)]">
        <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">Business details</h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">
              Business Type
            </label>
            <select
              value={form.businessType}
              onChange={(e) => setForm({ ...form, businessType: e.target.value })}
              className="h-[var(--density-control-height)] w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {BUSINESS_TYPES.map((t) => (
                <option key={t} value={t} className="capitalize">
                  {t.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">
              Source
            </label>
            <select
              value={form.source}
              onChange={(e) => setForm({ ...form, source: e.target.value })}
              className="h-[var(--density-control-height)] w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
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
          <label className="mb-2 block text-sm font-medium text-foreground">
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
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-line bg-background text-muted-foreground hover:border-line-strong hover:text-foreground"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-foreground">
            Description
          </label>
          <Textarea
            rows={3}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className="min-h-24"
            placeholder="Notes about what the client needs..."
          />
        </div>
      </div>

      <div className="v-card space-y-4 p-[var(--density-card-padding)]">
        <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">Lead management</h2>

        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">
              Status
            </label>
            <select
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
              className="h-[var(--density-control-height)] w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s} className="capitalize">
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">
              Quote Amount (R)
            </label>
            <Input
              type="number"
              value={form.quoteAmount || ""}
              onChange={(e) =>
                setForm({
                  ...form,
                  quoteAmount: e.target.value ? Number(e.target.value) : null,
                })
              }
              className="[appearance:textfield]"
              placeholder="e.g. 2500"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">
              Follow-up Date
            </label>
            <Input
              type="date"
              value={form.followUpDate}
              onChange={(e) => setForm({ ...form, followUpDate: e.target.value })}
            />
          </div>
        </div>
      </div>

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={loading}
          className={buttonClassName({ size: "lg" })}
        >
          {loading ? "Saving..." : isEdit ? "Update Lead" : "Create Lead"}
        </button>
        <button
          type="button"
          onClick={() => router.back()}
          className={buttonClassName({ variant: "ghost", size: "lg" })}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
