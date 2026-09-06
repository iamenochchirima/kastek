"use client";

import Link from "next/link";
import { AsYouType, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { useEffect, useState, type FormEvent } from "react";
import { phoneCountries } from "@/lib/phone-countries";

type EnquiryMode = "contact" | "quote";

type ProjectEnquiryFormProps = {
  mode: EnquiryMode;
};

const businessTypes = [
  { value: "professional_services", label: "Professional services" },
  { value: "retail", label: "Retail or e-commerce" },
  { value: "healthcare", label: "Healthcare or medical" },
  { value: "construction", label: "Construction or trades" },
  { value: "restaurant", label: "Hospitality or food service" },
  { value: "real_estate", label: "Property or real estate" },
  { value: "automotive", label: "Automotive" },
  { value: "salon_spa", label: "Beauty or wellness" },
  { value: "logistics", label: "Logistics or transport" },
  { value: "other", label: "Something else" },
];

const serviceOptions = [
  {
    value: "kasitek_implementation",
    label: "Kasitek platform",
    detail: "Workspace setup, configuration or extension",
  },
  {
    value: "custom_ai_chatbots",
    label: "AI agents",
    detail: "Messaging, voice or operational agent roles",
  },
  {
    value: "system_integrations",
    label: "Workflows and integrations",
    detail: "AI workflows connected to existing systems",
  },
  {
    value: "digital_infrastructure",
    label: "Applications and portals",
    detail: "Customer-facing or internal software",
  },
  {
    value: "managed_retainers",
    label: "Forward-deployed delivery",
    detail: "Engineering embedded through launch and iteration",
    comingSoon: true,
  },
  {
    value: "white_label_partnership",
    label: "Partnership",
    detail: "Branded workspaces and technical delivery",
  },
];

const serviceAliases: Record<string, string> = {
  platform: "kasitek_implementation",
  kasitek: "kasitek_implementation",
  "kasitek platform": "kasitek_implementation",
  "kasitek implementation": "kasitek_implementation",
  agents: "custom_ai_chatbots",
  "ai agents": "custom_ai_chatbots",
  "voice agents": "custom_ai_chatbots",
  workflows: "system_integrations",
  integrations: "system_integrations",
  "workflows and integrations": "system_integrations",
  applications: "digital_infrastructure",
  portals: "digital_infrastructure",
  "applications and portals": "digital_infrastructure",
  delivery: "managed_retainers",
  "forward-deployed delivery": "managed_retainers",
  partnership: "white_label_partnership",
};

export function ProjectEnquiryForm({ mode }: ProjectEnquiryFormProps) {
  const [businessName, setBusinessName] = useState("");
  const [contactPerson, setContactPerson] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneCountry, setPhoneCountry] = useState<CountryCode>("ZA");
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [email, setEmail] = useState("");
  const [businessType, setBusinessType] = useState("");
  const [services, setServices] = useState<string[]>([]);
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const requested = search.get("service") ?? search.get("type");
    if (!requested) return;

    const match = serviceAliases[requested.trim().toLowerCase()];
    const service = serviceOptions.find((option) => option.value === match);
    if (service && !service.comingSoon) setServices([service.value]);
  }, []);

  function toggleService(value: string) {
    setServices((current) =>
      current.includes(value)
        ? current.filter((service) => service !== value)
        : [...current, value],
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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    if (
      !businessName.trim() ||
      !contactPerson.trim() ||
      !email.trim() ||
      !businessType ||
      services.length === 0
    ) {
      setError("Complete the required fields and choose at least one area.");
      return;
    }

    const parsedPhone = phone.trim()
      ? parsePhoneNumberFromString(phone, phoneCountry)
      : undefined;
    if (!parsedPhone?.isValid()) {
      setPhoneTouched(true);
      setError("Enter a valid international phone number.");
      return;
    }

    setLoading(true);

    try {
      const response = await fetch("/api/quote-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          businessName,
          contactPerson,
          phone: parsedPhone.number,
          email,
          businessType,
          services,
          description: description || undefined,
        }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
      };

      if (!response.ok) {
        setError(result.error ?? "We could not submit this enquiry. Try again.");
        return;
      }

      setSuccess(true);
    } catch {
      setError("We could not submit this enquiry. Try again.");
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div className="enquiry-success" role="status">
        <span aria-hidden="true">✓</span>
        <h2>Received.</h2>
        <p>
          We&apos;ll review the details and contact you about the next step.
        </p>
        <Link href="/">Return to the homepage</Link>
      </div>
    );
  }

  return (
    <form className="enquiry-form" onSubmit={submit}>
      {error ? (
        <p className="enquiry-error" role="alert">
          {error}
        </p>
      ) : null}

      <fieldset>
        <legend>About the business</legend>
        <div className="enquiry-fields">
          <label>
            <span>Business name *</span>
            <input
              required
              value={businessName}
              onChange={(event) => setBusinessName(event.target.value)}
              placeholder="Business or organisation"
            />
          </label>
          <label>
            <span>Business type *</span>
            <select
              required
              value={businessType}
              onChange={(event) => setBusinessType(event.target.value)}
            >
              <option value="">Select one</option>
              {businessTypes.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Your details</legend>
        <div className="enquiry-fields">
          <label>
            <span>Name *</span>
            <input
              required
              autoComplete="name"
              value={contactPerson}
              onChange={(event) => setContactPerson(event.target.value)}
              placeholder="Full name"
            />
          </label>
          <label>
            <span>Phone or WhatsApp *</span>
            <div className="phone-input">
              <select
                aria-label="Country"
                value={phoneCountry}
                onChange={(event) => updatePhoneCountry(event.target.value)}
              >
                {phoneCountries.map((country) => (
                  <option key={country.code} value={country.code}>
                    {country.name} (+{country.callingCode})
                  </option>
                ))}
              </select>
              <input
                required
                aria-label="Phone or WhatsApp number"
                aria-invalid={
                  phoneTouched &&
                  (!phone || !parsePhoneNumberFromString(phone, phoneCountry)?.isValid())
                }
                type="tel"
                autoComplete="tel"
                value={phone}
                onChange={(event) => updatePhone(event.target.value)}
                placeholder="73 123 4567"
              />
            </div>
            {phoneTouched && phone ? (
              <small
                className={`phone-status ${parsePhoneNumberFromString(phone, phoneCountry)?.isValid() ? "is-valid" : "is-invalid"}`}
              >
                {parsePhoneNumberFromString(phone, phoneCountry)?.isValid()
                  ? `Valid number · ${parsePhoneNumberFromString(phone, phoneCountry)?.number}`
                  : "Enter a valid number for this country"}
              </small>
            ) : null}
          </label>
          <label className="enquiry-field-wide">
            <span>Email *</span>
            <input
              required
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@company.com"
            />
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>{mode === "quote" ? "What should we scope?" : "What is this about?"}</legend>
        <div className="enquiry-options">
          {serviceOptions.map((service) => {
            const selected = services.includes(service.value);
            return (
              <button
                key={service.value}
                type="button"
                className={`${selected ? "is-selected " : ""}${service.comingSoon ? "is-coming-soon" : ""}`}
                aria-pressed={selected}
                disabled={service.comingSoon}
                onClick={() => toggleService(service.value)}
              >
                <span>{service.comingSoon ? "—" : selected ? "✓" : "+"}</span>
                <strong>
                  {service.label}
                  {service.comingSoon ? <em>Coming soon</em> : null}
                </strong>
                <small>{service.detail}</small>
              </button>
            );
          })}
        </div>
      </fieldset>

      <label className="enquiry-notes">
        <span>{mode === "quote" ? "What needs to be built?" : "Tell us what you need."}</span>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={6}
          placeholder={
            mode === "quote"
              ? "Describe the work, the current setup and what the finished system should do."
              : "A short description is enough. Include any useful timing or system details."
          }
        />
      </label>

      <button className="button button-acid enquiry-submit" disabled={loading}>
        {loading
          ? "Sending…"
          : mode === "quote"
            ? "Request a quote"
            : "Send enquiry"}
      </button>
    </form>
  );
}
