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
  { value: "whatsapp_chatbot", label: "WhatsApp Chatbot" },
  { value: "voice_agent", label: "AI Voice Agent" },
  { value: "website_chatbot", label: "Website Chatbot" },
  { value: "custom_agent", label: "Custom AI Agent" },
];

export default function QuoteRequestForm() {
  const [businessName, setBusinessName] = useState("");
  const [contactPerson, setContactPerson] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [businessType, setBusinessType] = useState("");
  const [services, setServices] = useState<string[]>([]);
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
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-accent/15 bg-accent-glow text-2xl">
          ✓
        </div>
        <h2 className="font-serif text-2xl text-text">Thank you!</h2>
        <p className="text-text-muted max-w-[400px] mx-auto">
          We&apos;ve received your quote request and will be in touch within 24 hours
          with a tailored proposal for your business.
        </p>
        <Link
          href="/"
          className="inline-block text-sm text-accent hover:underline"
        >
          Back to Home
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-center text-sm text-red-400">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-text">
            Business Name <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            placeholder="e.g. Mama's Kitchen"
            required
            className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
          />
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-text">
            Contact Person <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={contactPerson}
            onChange={(e) => setContactPerson(e.target.value)}
            placeholder="Your full name"
            required
            className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text">
              Phone Number <span className="text-red-400">*</span>
            </label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+27 72 123 4567"
              required
              className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text">
              Email <span className="text-red-400">*</span>
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              required
              className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
            />
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-text">
            Business Type <span className="text-red-400">*</span>
          </label>
          <select
            value={businessType}
            onChange={(e) => setBusinessType(e.target.value)}
            required
            className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text focus:border-accent focus:outline-none appearance-none"
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

        <div>
          <label className="mb-1.5 block text-sm font-medium text-text">
            Services Needed <span className="text-red-400">*</span>
          </label>
          <div className="flex flex-wrap gap-3 mt-1">
            {serviceOptions.map((service) => (
              <button
                key={service.value}
                type="button"
                onClick={() => toggleService(service.value)}
                className={`rounded-full px-4 py-2 text-sm font-medium transition-all ${
                  services.includes(service.value)
                    ? "bg-accent text-bg"
                    : "border border-border bg-surface text-text-muted hover:border-text-muted"
                }`}
              >
                {service.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-text">
            Tell us about your business{" "}
            <span className="text-text-dim font-normal">(optional)</span>
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What does your business do? What problems are you looking to solve with AI?"
            rows={4}
            className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text placeholder:text-text-dim focus:border-accent focus:outline-none resize-none"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-full bg-accent px-6 py-3.5 text-sm font-semibold text-bg transition-all hover:-translate-y-0.5 hover:shadow-[0_4px_20px_rgba(196,240,77,0.25)] disabled:opacity-50 disabled:hover:translate-y-0"
        >
          {loading ? "Submitting..." : "Get My Free Quote"}
        </button>
      </form>
    </div>
  );
}
