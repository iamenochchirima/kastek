"use client";

interface StepReviewProps {
  data: {
    type: string;
    name: string;
    businessType: string;
    language: string;
    description: string;
    services: string;
    operatingHours: string;
    whatsappNumber: string;
  };
}

const typeLabels: Record<string, string> = {
  starter: "Starter — Menu-driven",
  growth: "Growth — AI-powered",
};

const languageLabels: Record<string, string> = {
  en: "English",
  zu: "isiZulu",
  af: "Afrikaans",
  st: "Sesotho",
  xh: "isiXhosa",
  tn: "Setswana",
};

export default function StepReview({ data }: StepReviewProps) {
  return (
    <div>
      <h2 className="mb-2 font-serif text-2xl">Review your bot</h2>
      <p className="mb-6 text-sm text-text-muted">
        Check the details below before creating your bot.
      </p>

      <div className="space-y-4 rounded-xl border border-border bg-surface p-5">
        <Row label="Bot type" value={typeLabels[data.type] || data.type} />
        <Row label="Bot name" value={data.name} />
        <Row label="Business type" value={data.businessType} />
        <Row label="Language" value={languageLabels[data.language] || data.language} />
        {data.description && <Row label="Description" value={data.description} />}
        {data.services && <Row label="Services" value={data.services} />}
        {data.operatingHours && <Row label="Hours" value={data.operatingHours} />}
        {data.whatsappNumber && <Row label="WhatsApp" value={data.whatsappNumber} />}
      </div>

      <div className="mt-6 rounded-xl border border-accent/20 bg-accent/5 p-4">
        <p className="text-sm font-medium text-accent">What happens next?</p>
        <p className="mt-1 text-sm text-text-muted">
          {data.type === "starter"
            ? "We'll generate a conversation flow based on your business details. You'll be able to customize the menu options, replies, and decision tree before activating."
            : "We'll configure an AI assistant trained on your business information. You can fine-tune responses and test conversations before going live."}
        </p>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-4">
      <span className="w-28 shrink-0 text-sm text-text-dim">{label}</span>
      <span className="text-sm text-text whitespace-pre-line">{value}</span>
    </div>
  );
}
