"use client";

interface StepBusinessDetailsProps {
  description: string;
  services: string;
  operatingHours: string;
  whatsappNumber: string;
  onChange: (field: string, value: string) => void;
}

export default function StepBusinessDetails({
  description,
  services,
  operatingHours,
  whatsappNumber,
  onChange,
}: StepBusinessDetailsProps) {
  return (
    <div>
      <h2 className="mb-2 text-2xl font-semibold tracking-tight">Business details</h2>
      <p className="mb-6 text-sm text-text-muted">
        Help your bot understand your business so it can assist customers better.
      </p>

      <div className="space-y-5">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-text">
            Business description
          </label>
          <textarea
            value={description}
            onChange={(e) => onChange("description", e.target.value)}
            placeholder="Briefly describe what your business does..."
            rows={3}
            className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text placeholder:text-text-dim focus:border-accent focus:outline-none resize-none"
          />
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-text">
            Services / Products
          </label>
          <textarea
            value={services}
            onChange={(e) => onChange("services", e.target.value)}
            placeholder="List your main services or products, one per line..."
            rows={3}
            className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text placeholder:text-text-dim focus:border-accent focus:outline-none resize-none"
          />
          <p className="mt-1 text-xs text-text-dim">One per line</p>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-text">
            Operating hours
          </label>
          <input
            type="text"
            value={operatingHours}
            onChange={(e) => onChange("operatingHours", e.target.value)}
            placeholder="e.g. Mon-Fri 8am-5pm, Sat 9am-1pm"
            className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
          />
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-text">
            WhatsApp number
          </label>
          <input
            type="tel"
            value={whatsappNumber}
            onChange={(e) => onChange("whatsappNumber", e.target.value)}
            placeholder="e.g. +27 81 234 5678"
            className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
          />
          <p className="mt-1 text-xs text-text-dim">
            The number customers will message on WhatsApp
          </p>
        </div>
      </div>
    </div>
  );
}
