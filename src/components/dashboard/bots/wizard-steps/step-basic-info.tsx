"use client";

interface StepBasicInfoProps {
  name: string;
  businessType: string;
  language: string;
  onChange: (field: string, value: string) => void;
}

const businessTypes = [
  "Restaurant / Food",
  "Retail / Shop",
  "Salon / Beauty",
  "Healthcare",
  "Transport / Logistics",
  "Professional Services",
  "Education / Training",
  "Real Estate",
  "Entertainment",
  "Other",
];

const languages = [
  { code: "en", label: "English" },
  { code: "zu", label: "isiZulu" },
  { code: "af", label: "Afrikaans" },
  { code: "st", label: "Sesotho" },
  { code: "xh", label: "isiXhosa" },
  { code: "tn", label: "Setswana" },
];

export default function StepBasicInfo({
  name,
  businessType,
  language,
  onChange,
}: StepBasicInfoProps) {
  return (
    <div>
      <h2 className="mb-2 font-serif text-2xl">Basic information</h2>
      <p className="mb-6 text-sm text-text-muted">
        Give your bot a name and tell us about your business.
      </p>

      <div className="space-y-5">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-text">
            Bot name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => onChange("name", e.target.value)}
            placeholder="e.g. Kasi Helper"
            className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
          />
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-text">
            Business type
          </label>
          <select
            value={businessType}
            onChange={(e) => onChange("businessType", e.target.value)}
            className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text focus:border-accent focus:outline-none"
          >
            <option value="">Select a business type</option>
            {businessTypes.map((bt) => (
              <option key={bt} value={bt}>
                {bt}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-text">
            Primary language
          </label>
          <select
            value={language}
            onChange={(e) => onChange("language", e.target.value)}
            className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text focus:border-accent focus:outline-none"
          >
            {languages.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
