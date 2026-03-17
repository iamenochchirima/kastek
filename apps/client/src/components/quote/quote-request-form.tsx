"use client";

import { useState } from "react";
import Link from "next/link";

const businessTypes = [
  { value: "restaurant", label: "Restaurant / Food & Beverage" },
  { value: "retail", label: "Retail / E-commerce" },
  { value: "healthcare", label: "Healthcare / Medical" },
  { value: "real_estate", label: "Real Estate" },
  { value: "automotive", label: "Automotive" },
  { value: "professional_services", label: "Professional Services" },
  { value: "salon_spa", label: "Salon / Spa / Beauty" },
  { value: "construction", label: "Construction / Trades" },
  { value: "logistics", label: "Logistics / Transport" },
  { value: "other", label: "Other" },
];

const serviceOptions = [
  { value: "custom_ai_chatbots", label: "Custom AI Chatbots" },
  { value: "voice_agents", label: "Voice Agents" },
  { value: "growth_workflows", label: "Growth Workflows" },
  { value: "system_integrations", label: "System Integrations" },
  { value: "digital_infrastructure", label: "Digital Infrastructure" },
  { value: "managed_retainers", label: "Managed Retainers" },
];

const serviceAliasMap: Record<string, string> = {
  "custom ai chatbots": "custom_ai_chatbots",
  "voice agents": "voice_agents",
  "growth workflows": "growth_workflows",
  "system integrations": "system_integrations",
  "digital infrastructure": "digital_infrastructure",
  "managed retainers": "managed_retainers",
};

export default function QuoteRequestForm() {
  const [businessName, setBusinessName] = useState("");
  const [contactPerson, setContactPerson] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [businessType, setBusinessType] = useState("");
  const [services, setServices] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];

    const service = new URLSearchParams(window.location.search).get("service");
    if (!service) return [];

    const normalized = service.trim().toLowerCase();
    const matched = serviceAliasMap[normalized];

    return matched ? [matched] : [];
  });
  const [customService, setCustomService] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const toggleService = (value: string) => {
    setServices((prev) =>
      prev.includes(value)
        ? prev.filter((s) => s !== value)
        : [...prev, value]
    );
  };

  const addCustomService = () => {
    const value = customService.trim();
    if (!value) return;
    setServices((prev) => (prev.includes(value) ? prev : [...prev, value]));
    setCustomService("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (
      !businessName ||
      !contactPerson ||
      !phone ||
      !email ||
      !businessType ||
      services.length === 0
    ) {
      setError("Please fill in all required fields and select at least one service");
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/quote-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessName,
          contactPerson,
          phone,
          email,
          businessType,
          services,
          description: description || undefined,
        }),
      });

      const data = await res.json();
      setLoading(false);

      if (!res.ok) {
        setError(data.error);
      } else {
        setSuccess(true);
      }
    } catch {
      setLoading(false);
      setError("Something went wrong. Please try again.");
    }
  };

  if (success) {
    return (
      <div className="space-y-4 text-center py-8">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-2xl text-primary shadow-[0_0_28px_rgba(232,160,32,0.2)]">
          ✓
        </div>
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">Thank you!</h2>
        <p className="mx-auto max-w-[400px] text-muted-foreground">
          We&apos;ve received your quote request and will be in touch within 24 hours
          with a tailored proposal for your business.
        </p>
        <Link
          href="/"
          className="inline-block text-sm font-medium text-primary transition hover:text-primary/85"
        >
          Back to Home
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-3 text-center text-sm text-red-200 sm:px-4">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5">
        <section className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-[0.12em] text-foreground">Business Details</h3>
            <p className="mt-1 text-xs text-muted-foreground">Tell us who the quote is for.</p>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground">
              Business Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              placeholder="e.g. Mama's Kitchen"
              required
              className="w-full rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-foreground placeholder:text-white/30 outline-none transition focus:border-primary/45 focus:bg-black/35"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground">
              Business Type <span className="text-red-400">*</span>
            </label>
            <select
              value={businessType}
              onChange={(e) => setBusinessType(e.target.value)}
              required
              className="w-full appearance-none rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-foreground outline-none transition focus:border-primary/45 focus:bg-black/35"
            >
              <option value="" disabled>
                Select your business type
              </option>
              {businessTypes.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
          </div>
        </section>

        <section className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-[0.12em] text-foreground">Contact Details</h3>
            <p className="mt-1 text-xs text-muted-foreground">Who should we contact for this proposal?</p>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground">
              Contact Person <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={contactPerson}
              onChange={(e) => setContactPerson(e.target.value)}
              placeholder="Your full name"
              required
              className="w-full rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-foreground placeholder:text-white/30 outline-none transition focus:border-primary/45 focus:bg-black/35"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-foreground">
                Phone Number <span className="text-red-400">*</span>
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+27 72 123 4567"
                required
                className="w-full rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-foreground placeholder:text-white/30 outline-none transition focus:border-primary/45 focus:bg-black/35"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-foreground">
                Email <span className="text-red-400">*</span>
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your@email.com"
                required
                className="w-full rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-foreground placeholder:text-white/30 outline-none transition focus:border-primary/45 focus:bg-black/35"
              />
            </div>
          </div>
        </section>

        <section className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-[0.12em] text-foreground">
              Services Needed <span className="text-red-400">*</span>
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Select one or more custom services, or add your own request.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {serviceOptions.map((service) => (
              <button
                key={service.value}
                type="button"
                onClick={() => toggleService(service.value)}
                className={`rounded-xl px-4 py-2.5 text-left text-sm font-medium transition-all ${
                  services.includes(service.value)
                    ? "border border-primary/35 bg-primary/12 text-primary shadow-[0_0_22px_rgba(232,160,32,0.08)]"
                    : "border border-white/10 bg-black/20 text-muted-foreground hover:border-white/20 hover:bg-white/[0.04] hover:text-foreground"
                }`}
              >
                {service.label}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              value={customService}
              onChange={(e) => setCustomService(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCustomService();
                }
              }}
              placeholder="Other service"
              className="w-full rounded-xl border border-white/10 bg-black/25 px-4 py-2.5 text-sm text-foreground placeholder:text-white/30 outline-none transition focus:border-primary/45 focus:bg-black/35"
            />
            <button
              type="button"
              onClick={addCustomService}
              className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm font-medium text-foreground transition hover:border-primary/25 hover:bg-primary/10 hover:text-primary"
            >
              Add
            </button>
          </div>

        </section>

        <section className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4">
          <label className="block text-sm font-medium text-foreground">
            Project Notes <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What does your business do? What are you trying to improve, automate, or launch?"
            rows={4}
            className="w-full resize-none rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-foreground placeholder:text-white/30 outline-none transition focus:border-primary/45 focus:bg-black/35"
          />
        </section>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-full bg-primary px-6 py-3.5 text-sm font-semibold text-primary-foreground transition-all hover:-translate-y-0.5 hover:bg-primary/90 hover:shadow-[0_10px_28px_rgba(232,160,32,0.28)] disabled:opacity-50 disabled:hover:translate-y-0"
        >
          {loading ? "Submitting..." : "Get My Free Quote"}
        </button>
      </form>
    </div>
  );
}
