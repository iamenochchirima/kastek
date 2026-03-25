"use client";

import { apiUrl } from "@/lib/server-api";
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

const productOptions = [
  { value: "kasitek_product_basic", label: "KasiTek Basic Plan" },
  { value: "kasitek_product_growth", label: "KasiTek Growth Plan" },
  { value: "kasitek_product_scale", label: "KasiTek Scale Plan" },
  { value: "kasiagents", label: "KasiAgents" },
  { value: "kasireach", label: "KasiReach" },
  { value: "kasisocial", label: "KasiSocial" },
];

const productAliasMap: Record<string, string> = {
  basic: "kasitek_product_basic",
  growth: "kasitek_product_growth",
  scale: "kasitek_product_scale",
  "basic plan": "kasitek_product_basic",
  "growth plan": "kasitek_product_growth",
  "scale plan": "kasitek_product_scale",
  kasiagents: "kasiagents",
  kasireach: "kasireach",
  kasisocial: "kasisocial",
};

export default function ProductWaitlistForm() {
  const [businessName, setBusinessName] = useState("");
  const [contactPerson, setContactPerson] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [businessType, setBusinessType] = useState("");
  const [products, setProducts] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];

    const product = new URLSearchParams(window.location.search).get("product");
    if (!product) return [];

    const normalized = product.trim().toLowerCase();
    const matched = productAliasMap[normalized];

    return matched ? [matched] : [];
  });
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const toggleProduct = (value: string) => {
    setProducts((prev) =>
      prev.includes(value)
        ? prev.filter((product) => product !== value)
        : [...prev, value]
    );
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");

    if (!businessName || !contactPerson || !email || products.length === 0) {
      setError("Please fill in the required fields and select at least one product");
      return;
    }

    setLoading(true);

    try {
      const response = await fetch(apiUrl("/api/waitlist"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessName,
          contactPerson,
          phone: phone || undefined,
          email,
          businessType: businessType || undefined,
          products,
          notes: notes || undefined,
        }),
      });

      const data = await response.json();
      setLoading(false);

      if (!response.ok) {
        setError(data.error || "Something went wrong. Please try again.");
        return;
      }

      setSuccess(true);
    } catch {
      setLoading(false);
      setError("Something went wrong. Please try again.");
    }
  };

  if (success) {
    return (
      <div className="space-y-4 py-8 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-2xl text-primary shadow-[0_0_28px_rgba(232,160,32,0.2)]">
          ✓
        </div>
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">
          You&apos;re on the list
        </h2>
        <p className="mx-auto max-w-[420px] text-muted-foreground">
          We&apos;ve received your product interest and will reach out when the next access
          batch or early rollout opens.
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
      {error ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-3 text-center text-sm text-red-200 sm:px-4">
          {error}
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="space-y-5">
        <section className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-[0.12em] text-foreground">
              Business Details
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Tell us who should get early access updates.
            </p>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground">
              Business Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={businessName}
              onChange={(event) => setBusinessName(event.target.value)}
              placeholder="e.g. Mama's Kitchen"
              required
              className="w-full rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-foreground placeholder:text-white/30 outline-none transition focus:border-primary/45 focus:bg-black/35"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground">
              Business Type
            </label>
            <select
              value={businessType}
              onChange={(event) => setBusinessType(event.target.value)}
              className="w-full appearance-none rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-foreground outline-none transition focus:border-primary/45 focus:bg-black/35"
            >
              <option value="">Select your business type</option>
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
            <h3 className="text-sm font-semibold uppercase tracking-[0.12em] text-foreground">
              Contact Details
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              We&apos;ll use this to keep you updated on release timing and access.
            </p>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground">
              Contact Person <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={contactPerson}
              onChange={(event) => setContactPerson(event.target.value)}
              placeholder="Your full name"
              required
              className="w-full rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-foreground placeholder:text-white/30 outline-none transition focus:border-primary/45 focus:bg-black/35"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-foreground">
                Phone / WhatsApp
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="+27 72 123 4567"
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
                onChange={(event) => setEmail(event.target.value)}
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
              Products
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Select the products you want early access to.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {productOptions.map((product) => (
              <button
                key={product.value}
                type="button"
                onClick={() => toggleProduct(product.value)}
                className={`rounded-xl px-4 py-2.5 text-left text-sm font-medium transition-all ${
                  products.includes(product.value)
                    ? "border border-primary/35 bg-primary/12 text-primary shadow-[0_0_22px_rgba(232,160,32,0.08)]"
                    : "border border-white/10 bg-black/20 text-muted-foreground hover:border-white/20 hover:bg-white/[0.04] hover:text-foreground"
                }`}
              >
                {product.label}
              </button>
            ))}
          </div>
        </section>

        <section className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4">
          <label className="block text-sm font-medium text-foreground">
            Notes <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="What do you want to use the product for, or what would make it valuable for your business?"
            rows={4}
            className="w-full resize-none rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-foreground placeholder:text-white/30 outline-none transition focus:border-primary/45 focus:bg-black/35"
          />
        </section>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-full bg-primary px-6 py-3.5 text-sm font-semibold text-primary-foreground transition-all hover:-translate-y-0.5 hover:bg-primary/90 hover:shadow-[0_10px_28px_rgba(232,160,32,0.28)] disabled:opacity-50 disabled:hover:translate-y-0"
        >
          {loading ? "Joining..." : "Join the Waitlist"}
        </button>
      </form>
    </div>
  );
}
