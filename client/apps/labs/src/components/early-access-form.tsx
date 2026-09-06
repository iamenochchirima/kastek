"use client";

import Link from "next/link";
import { AsYouType, getCountries, getCountryCallingCode, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { useState, type FormEvent } from "react";

const businessTypes = [
  ["individual", "Individual"],
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

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const stableCountryNames: Partial<Record<CountryCode, string>> = {
  FK: "Falkland Islands",
  HK: "Hong Kong SAR China",
  MO: "Macao SAR China",
  PS: "Palestinian Territories",
};

function countrySortKey(name: string) {
  return name.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

const phoneCountries = getCountries()
  .map((code) => ({
    code,
    name: stableCountryNames[code] ?? regionNames.of(code) ?? code,
    callingCode: getCountryCallingCode(code),
  }))
  .sort((left, right) => {
    const leftKey = countrySortKey(left.name);
    const rightKey = countrySortKey(right.name);
    if (leftKey < rightKey) return -1;
    if (leftKey > rightKey) return 1;
    return left.code < right.code ? -1 : left.code > right.code ? 1 : 0;
  });

export function EarlyAccessForm() {
  const [businessName, setBusinessName] = useState("");
  const [contactPerson, setContactPerson] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneCountry, setPhoneCountry] = useState<CountryCode>("ZA");
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [companyWebsite, setCompanyWebsite] = useState("");
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

  function updatePhoneCountry(value: string) {
    const nextCountry = value as CountryCode;
    setPhoneCountry(nextCountry);
    if (phone.trim() && !phone.trim().startsWith("+")) {
      setPhone(new AsYouType(nextCountry).input(phone));
    }
  }

  function updatePhone(value: string) {
    setPhoneTouched(true);
    setPhone(new AsYouType(phoneCountry).input(value));
  }

  function normalizeWebsite(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
      const url = new URL(candidate);
      return ["http:", "https:"].includes(url.protocol) && url.hostname ? url.toString() : null;
    } catch {
      return null;
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!contactPerson.trim() || !email.trim() || !selectedProducts.length || !contactConsent) {
      setError("Complete the required fields and consent to be contacted.");
      return;
    }
    const normalizedWebsite = normalizeWebsite(companyWebsite);
    if (companyWebsite.trim() && !normalizedWebsite) {
      setError("Enter a valid company website.");
      return;
    }
    const parsedPhone = phone.trim() ? parsePhoneNumberFromString(phone, phoneCountry) : undefined;
    if (phone.trim() && !parsedPhone?.isValid()) {
      setPhoneTouched(true);
      setError("Enter a valid international phone number.");
      return;
    }
    setLoading(true);
    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          businessName: businessName.trim() || undefined,
          contactPerson,
          phone: parsedPhone?.number ?? undefined,
          email,
          businessType: businessType || undefined,
          companyWebsite: normalizedWebsite,
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
        <legend>About you</legend>
        <div className="enquiry-fields">
          <label>
            <span>Company name</span>
            <input value={businessName} onChange={(event) => setBusinessName(event.target.value)} placeholder="Company name (optional)" />
          </label>
          <label>
            <span>Company type</span>
            <select value={businessType} onChange={(event) => setBusinessType(event.target.value)}>
              <option value="">Select one (optional)</option>
              {businessTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="enquiry-field-wide">
            <span>Company website</span>
            <input type="url" autoComplete="url" value={companyWebsite} onChange={(event) => setCompanyWebsite(event.target.value)} placeholder="https://example.com (optional)" />
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
            <span>Phone or WhatsApp (optional)</span>
            <div className="phone-input">
              <select aria-label="Country" value={phoneCountry} onChange={(event) => updatePhoneCountry(event.target.value)}>
                {phoneCountries.map((country) => <option key={country.code} value={country.code}>{country.name} (+{country.callingCode})</option>)}
              </select>
              <input aria-label="Phone or WhatsApp number" aria-invalid={phoneTouched && Boolean(phone) && !parsePhoneNumberFromString(phone, phoneCountry)?.isValid()} type="tel" autoComplete="tel" value={phone} onChange={(event) => updatePhone(event.target.value)} placeholder="73 123 4567" />
            </div>
            {phoneTouched && phone ? <small className={`phone-status ${parsePhoneNumberFromString(phone, phoneCountry)?.isValid() ? "is-valid" : "is-invalid"}`}>{parsePhoneNumberFromString(phone, phoneCountry)?.isValid() ? `Valid number · ${parsePhoneNumberFromString(phone, phoneCountry)?.number}` : "Enter a valid number for this country"}</small> : null}
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
