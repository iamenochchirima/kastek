"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

const businessTypes = [
  ["professional_services", "Professional services"],
  ["retail", "Retail or e-commerce"],
  ["healthcare", "Healthcare or medical"],
  ["construction", "Construction or trades"],
  ["restaurant", "Hospitality or food service"],
  ["real_estate", "Property or real estate"],
  ["automotive", "Automotive"],
  ["salon_spa", "Beauty or wellness"],
  ["logistics", "Logistics or transport"],
  ["other", "Something else"],
] as const;

const products = [
  { value: "kasitek_product_basic", label: "Core workspace", detail: "Inbox, contacts and everyday operations" },
  { value: "kasitek_product_growth", label: "Growth workflows", detail: "Campaigns, content and customer follow-up" },
  { value: "kasitek_product_scale", label: "Automation", detail: "Agents and connected business workflows" },
];

export function EarlyAccessForm() {
  const [businessName, setBusinessName] = useState("");
  const [contactPerson, setContactPerson] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [businessType, setBusinessType] = useState("");
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [contactConsent, setContactConsent] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  function toggleProduct(value: string) {
    setSelectedProducts((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!businessName.trim() || !contactPerson.trim() || !email.trim() || !businessType || !selectedProducts.length || !contactConsent) {
      setError("Complete the required fields and consent to be contacted.");
      return;
    }
    setLoading(true);
    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          businessName,
          contactPerson,
          phone: phone || undefined,
          email,
          businessType,
          products: selectedProducts,
          notes: notes || undefined,
          contactConsent: true,
        }),
      });
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(result.error ?? "We could not submit your application. Try again.");
        return;
      }
      setSuccess(true);
    } catch {
      setError("We could not submit your application. Try again.");
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div className="enquiry-success" role="status">
        <span aria-hidden="true">✓</span>
        <h2>Thank you for applying.</h2>
        <p>We&apos;ve received your application and will be in touch with next steps.</p>
        <Link href="/">Return to the homepage</Link>
      </div>
    );
  }

  return (
    <form className="enquiry-form early-access-form" onSubmit={submit}>
      {error ? <p className="enquiry-error" role="alert">{error}</p> : null}

      <fieldset>
        <legend>About the business</legend>
        <div className="enquiry-fields">
          <label>
            <span>Business name *</span>
            <input required value={businessName} onChange={(event) => setBusinessName(event.target.value)} placeholder="Business or organisation" />
          </label>
          <label>
            <span>Business type *</span>
            <select required value={businessType} onChange={(event) => setBusinessType(event.target.value)}>
              <option value="">Select one</option>
              {businessTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Your details</legend>
        <div className="enquiry-fields">
          <label>
            <span>Name *</span>
            <input required autoComplete="name" value={contactPerson} onChange={(event) => setContactPerson(event.target.value)} placeholder="Full name" />
          </label>
          <label>
            <span>Phone or WhatsApp</span>
            <input type="tel" autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+27" />
          </label>
          <label className="enquiry-field-wide">
            <span>Email *</span>
            <input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@company.com" />
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>What should we open up?</legend>
        <div className="enquiry-options">
          {products.map((product) => {
            const selected = selectedProducts.includes(product.value);
            return (
              <button key={product.value} type="button" className={selected ? "is-selected" : ""} aria-pressed={selected} onClick={() => toggleProduct(product.value)}>
                <span>{selected ? "✓" : "+"}</span>
                <strong>{product.label}</strong>
                <small>{product.detail}</small>
              </button>
            );
          })}
        </div>
      </fieldset>

      <label className="enquiry-notes">
        <span>Primary use case</span>
        <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={5} placeholder="What would you like to improve first?" />
      </label>

      <label className="early-access-consent">
        <input type="checkbox" checked={contactConsent} onChange={(event) => setContactConsent(event.target.checked)} />
        <span>I agree to be contacted about KasiTek beta access. *</span>
      </label>

      <button className="button button-acid enquiry-submit" disabled={loading}>
        {loading ? "Sending…" : "Apply for early access"}
      </button>
    </form>
  );
}
