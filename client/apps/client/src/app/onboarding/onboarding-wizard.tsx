"use client";

import { apiUrl } from "@/lib/server-api";
import type { OnboardingProfile } from "@/lib/onboarding";
import { ArrowLeft, ArrowRight, Check, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const steps = ["Business", "Goal", "Role", "Industry", "Source"];

const choices = {
  goal: [
    ["messages", "Customer messages", "Connect channels and manage every conversation from one inbox."],
    ["agents", "AI agents", "Answer questions, capture leads, and hand off to your team."],
    ["content", "Content", "Plan, schedule and publish multi-platform content for your business."],
    ["bookings", "Bookings", "Let customers schedule your services online."],
    ["campaigns", "Campaigns", "Reach opted-in contacts with WhatsApp campaigns."],
    ["explore", "Explore", "Look around and decide what to set up later."],
  ],
  role: ["Owner or founder", "Marketing or social media", "Sales or customer support", "Engineer or developer", "Operations or admin", "Agency or consultant", "Other"],
  industry: ["Accounting or finance", "Agriculture", "Automotive", "Beauty or wellness", "Construction or trades", "Consulting", "Creative or media", "Education or training", "Energy or utilities", "Engineering", "Events or entertainment", "Healthcare", "Hospitality or tourism", "Insurance", "Legal", "Manufacturing", "Marketing or advertising", "Nonprofit", "Professional services", "Property or real estate", "Restaurant or food service", "Retail or e-commerce", "Software or technology", "Telecommunications", "Transport or logistics", "Other"],
  source: ["Search engine", "Social media", "A friend or referral", "KasiTek team or event", "Advertisement", "Other"],
} as const;

const goalImages: Record<string, string> = {
  messages: "/images/onboarding-previews/messages-editorial.png",
  agents: "/images/custom-services/automation.png",
  content: "/images/custom-services/agencies-content.png",
  bookings: "/images/custom-services/booking.png",
  campaigns: "/images/custom-services/campaigns.png",
  explore: "/images/custom-services/portal.png",
};

function destination(goal: string) {
  return {
    messages: "/connections",
    agents: "/agents",
    content: "/content",
    bookings: "/bookings",
    campaigns: "/campaigns",
    explore: "/workspace",
  }[goal] ?? "/workspace";
}

export function OnboardingWizard({ profile }: { profile: OnboardingProfile }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [companyName, setCompanyName] = useState(profile.orgName);
  const [website, setWebsite] = useState(profile.website ?? "");
  const [primaryGoals, setPrimaryGoals] = useState(profile.primaryGoals?.length ? profile.primaryGoals : profile.primaryGoal ? [profile.primaryGoal] : []);
  const [teamRole, setTeamRole] = useState(profile.teamRole ?? "");
  const [industry, setIndustry] = useState(profile.industry ?? "");
  const [referralSource, setReferralSource] = useState(profile.referralSource ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const selected = [companyName.trim(), primaryGoals.length > 0, teamRole, industry, referralSource][step];
  const canContinue = step === 0 ? Boolean(companyName.trim()) : step === 4 || Boolean(selected);

  async function save({ skip = false } = {}) {
    setError("");
    setSaving(true);
    try {
      const response = await fetch(apiUrl("/api/onboarding"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(
          skip
            ? { companyName, skip: true }
            : { companyName, website, primaryGoal: primaryGoals[0], primaryGoals, teamRole, industry, referralSource, complete: true },
        ),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "We could not save your workspace setup.");
      router.replace(skip ? "/workspace" : destination(primaryGoals[0]));
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "We could not save your workspace setup.");
      setSaving(false);
    }
  }

  function next() {
    if (step === 0 && !companyName.trim()) {
      setError("Enter your company name to continue.");
      return;
    }
    if (step < steps.length - 1) {
      setError("");
      setStep((current) => current + 1);
      return;
    }
    void save();
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-8 text-foreground sm:px-6">
      <div className={`w-full rounded-2xl border border-border bg-card p-6 shadow-[0_24px_80px_rgba(0,0,0,0.18)] sm:p-8 ${step === 1 ? "max-w-5xl" : "max-w-lg"}`}>
        <div className="flex items-center justify-between gap-4">
          <div>
            <span className="text-sm font-semibold tracking-tight text-foreground">Kasi<span className="text-primary">Tek</span></span>
            <p className="mt-0.5 text-xs text-muted-foreground">Workspace setup</p>
          </div>
          <span className="rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-muted-foreground">Step {step + 1} of {steps.length}</span>
        </div>
        <div className="mt-6 flex gap-1.5" aria-label={`Step ${step + 1} of ${steps.length}`}>
          {steps.map((name, index) => <span key={name} className={`h-1 flex-1 rounded-full transition-colors ${index <= step ? "bg-primary" : "bg-secondary"}`} />)}
        </div>

        <div className="py-8 sm:py-10">
          {step === 0 ? <BusinessStep companyName={companyName} setCompanyName={setCompanyName} website={website} setWebsite={setWebsite} /> : null}
          {step === 1 ? <ChoiceStep title="What would you like to set up first?" description="" options={choices.goal} value="" selectedValues={primaryGoals} onChange={(goal) => setPrimaryGoals((current) => current.includes(goal) ? current.filter((item) => item !== goal) : [...current, goal])} visual multiple /> : null}
          {step === 2 ? <ChoiceStep title="What best describes you?" description="" options={choices.role} value={teamRole} onChange={setTeamRole} /> : null}
          {step === 3 ? <IndustryStep value={industry} onChange={setIndustry} /> : null}
          {step === 4 ? <ChoiceStep title="How did you hear about KasiTek?" description="" options={choices.source} value={referralSource} onChange={setReferralSource} optional /> : null}
          {error ? <p className="mt-5 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border pt-5">
          {step > 0 ? <div className="flex items-center gap-1"><Button type="button" variant="ghost" size="sm" onClick={() => { setError(""); setStep((current) => current - 1); }}><ArrowLeft className="h-4 w-4" />Back</Button><Button type="button" variant="ghost" size="sm" onClick={() => void save({ skip: true })} disabled={saving}>Skip</Button></div> : <span />}
          <Button type="button" onClick={next} disabled={!canContinue || saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : step === steps.length - 1 ? <Check className="h-4 w-4" /> : null}
            {saving ? "Saving…" : step === steps.length - 1 ? "Finish setup" : "Continue"}
            {!saving && step < steps.length - 1 ? <ArrowRight className="h-4 w-4" /> : null}
          </Button>
        </div>
      </div>
    </main>
  );
}

function BusinessStep({ companyName, setCompanyName, website, setWebsite }: { companyName: string; setCompanyName: (value: string) => void; website: string; setWebsite: (value: string) => void }) {
  return <div><span className="inline-flex rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">Business details</span><h1 className="mt-4 text-3xl font-semibold tracking-tight">Tell us about your business</h1><p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">Start with the essentials. Your website is optional.</p><label className="mt-7 block text-sm font-medium">Company name<Input autoFocus value={companyName} onChange={(event) => setCompanyName(event.target.value)} className="mt-2" placeholder="Your business name" /></label><label className="mt-4 block text-sm font-medium">Website <span className="font-normal text-muted-foreground">(optional)</span><Input type="url" value={website} onChange={(event) => setWebsite(event.target.value)} className="mt-2" placeholder="https://yourbusiness.com" /></label></div>;
}

function IndustryStep({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <div><h1 className="text-3xl font-semibold tracking-tight">What industry are you in?</h1><label className="mt-8 block text-sm font-medium">Industry<select value={value} onChange={(event) => onChange(event.target.value)} className="mt-2 w-full rounded-lg border border-input bg-background px-3.5 py-3 text-base text-foreground outline-none transition focus:border-primary focus-visible:ring-2 focus-visible:ring-ring"><option value="" disabled>Select an industry</option>{choices.industry.map((industryOption) => <option key={industryOption} value={industryOption}>{industryOption}</option>)}</select></label></div>;
}

function ChoiceStep({ title, description, options, value, selectedValues = [], onChange, optional = false, visual = false, multiple = false }: { title: string; description: string; options: readonly (string | readonly string[])[]; value: string; selectedValues?: string[]; onChange: (value: string) => void; optional?: boolean; visual?: boolean; multiple?: boolean }) {
  return <div><h1 className="text-3xl font-semibold tracking-tight">{title}</h1>{description ? <p className="mt-3 max-w-2xl text-muted-foreground">{description}</p> : null}<div className={`mt-8 grid gap-3 ${visual ? "md:grid-cols-3" : ""}`}>{options.map((option) => { const [key, label, detail] = Array.isArray(option) ? option : [option, option]; const image = goalImages[key]; const isSelected = multiple ? selectedValues.includes(key) : value === key; const cardClassName = visual ? `group relative flex min-h-52 flex-col justify-end overflow-hidden rounded-xl border bg-center p-4 text-left transition duration-200 hover:-translate-y-0.5 hover:border-primary/70 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${isSelected ? "border-primary ring-2 ring-primary/50" : "border-border"}` : `rounded-lg border p-3 text-left transition ${isSelected ? "border-primary bg-primary/10" : "border-border hover:border-primary/50 hover:bg-secondary/50"}`; return <button type="button" key={key} onClick={() => onChange(key)} style={visual ? { backgroundImage: `linear-gradient(180deg, rgba(13, 15, 20, 0.28) 0%, rgba(13, 15, 20, 0.7) 42%, rgb(7, 8, 11) 100%), url(${image})`, backgroundSize: "100% 100%, 118%", backgroundRepeat: "no-repeat" } : undefined} className={cardClassName}>{visual && isSelected ? <span className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg"><Check className="h-4 w-4" strokeWidth={3} /></span> : null}<span className={`block font-semibold text-foreground ${visual ? "text-base [text-shadow:0_1px_12px_rgb(0_0_0_/_0.9)]" : "text-sm"}`}>{label}</span>{detail ? <span className={`mt-1 block ${visual ? "text-sm leading-5 text-white/90 [text-shadow:0_1px_10px_rgb(0_0_0_/_0.9)]" : "text-xs text-muted-foreground"}`}>{detail}</span> : null}</button>; })}</div>{optional ? <button type="button" onClick={() => onChange("")} className="mt-3 text-sm text-muted-foreground hover:text-foreground">Prefer not to say</button> : null}</div>;
}
