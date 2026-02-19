"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import WizardProgress from "./wizard-progress";
import StepChooseType from "./wizard-steps/step-choose-type";
import StepBasicInfo from "./wizard-steps/step-basic-info";
import StepBusinessDetails from "./wizard-steps/step-business-details";
import StepReview from "./wizard-steps/step-review";

interface WizardData {
  type: string;
  name: string;
  businessType: string;
  language: string;
  description: string;
  services: string;
  operatingHours: string;
  whatsappNumber: string;
}

const initialData: WizardData = {
  type: "",
  name: "",
  businessType: "",
  language: "en",
  description: "",
  services: "",
  operatingHours: "",
  whatsappNumber: "",
};

export default function CreateBotWizard() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [data, setData] = useState<WizardData>(initialData);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const updateField = (field: string, value: string) => {
    setData((prev) => ({ ...prev, [field]: value }));
  };

  const canProceed = () => {
    switch (step) {
      case 0:
        return data.type !== "";
      case 1:
        return data.name.trim() !== "" && data.businessType !== "";
      case 2:
        return true;
      case 3:
        return true;
      default:
        return false;
    }
  };

  const handleSubmit = async () => {
    setError("");
    setSubmitting(true);

    try {
      const res = await fetch("/api/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.name,
          type: data.type,
          language: data.language,
          businessDetails: {
            businessType: data.businessType,
            description: data.description,
            services: data.services,
            operatingHours: data.operatingHours,
            whatsappNumber: data.whatsappNumber,
          },
        }),
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || "Failed to create bot");
      }

      const { bot } = await res.json();
      router.push(`/dashboard/bots/${bot.id}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setSubmitting(false);
    }
  };

  return (
    <div>
      <WizardProgress currentStep={step} />

      {error && (
        <div className="mb-6 rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {step === 0 && (
        <StepChooseType
          selected={data.type}
          onSelect={(type) => updateField("type", type)}
        />
      )}
      {step === 1 && (
        <StepBasicInfo
          name={data.name}
          businessType={data.businessType}
          language={data.language}
          onChange={updateField}
        />
      )}
      {step === 2 && (
        <StepBusinessDetails
          description={data.description}
          services={data.services}
          operatingHours={data.operatingHours}
          whatsappNumber={data.whatsappNumber}
          onChange={updateField}
        />
      )}
      {step === 3 && <StepReview data={data} />}

      <div className="mt-8 flex items-center justify-between">
        {step > 0 ? (
          <button
            onClick={() => setStep((s) => s - 1)}
            className="rounded-full border border-border px-5 py-2.5 text-sm font-medium text-text transition-colors hover:border-border-light"
          >
            Back
          </button>
        ) : (
          <div />
        )}

        {step < 3 ? (
          <button
            onClick={() => setStep((s) => s + 1)}
            disabled={!canProceed()}
            className="rounded-full bg-accent px-6 py-2.5 text-sm font-semibold text-bg transition-all hover:-translate-y-0.5 hover:shadow-[0_4px_20px_rgba(196,240,77,0.25)] disabled:opacity-50 disabled:hover:translate-y-0"
          >
            Continue
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="rounded-full bg-accent px-6 py-2.5 text-sm font-semibold text-bg transition-all hover:-translate-y-0.5 hover:shadow-[0_4px_20px_rgba(196,240,77,0.25)] disabled:opacity-50 disabled:hover:translate-y-0"
          >
            {submitting ? "Creating..." : "Create Bot"}
          </button>
        )}
      </div>
    </div>
  );
}
