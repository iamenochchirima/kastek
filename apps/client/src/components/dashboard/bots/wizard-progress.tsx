"use client";

const steps = ["Type", "Info", "Details", "Review"];

export default function WizardProgress({ currentStep }: { currentStep: number }) {
  return (
    <div className="mb-8 flex items-center gap-2">
      {steps.map((label, i) => (
        <div key={label} className="flex items-center gap-2">
          <div className="flex items-center gap-2">
            <div
              className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
                i < currentStep
                  ? "bg-accent text-bg"
                  : i === currentStep
                    ? "border-2 border-accent text-accent"
                    : "border border-border text-text-dim"
              }`}
            >
              {i < currentStep ? "✓" : i + 1}
            </div>
            <span
              className={`text-sm ${
                i <= currentStep ? "text-text" : "text-text-dim"
              }`}
            >
              {label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div
              className={`h-px w-8 ${
                i < currentStep ? "bg-accent" : "bg-border"
              }`}
            />
          )}
        </div>
      ))}
    </div>
  );
}
