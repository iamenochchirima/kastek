"use client";

import { ArrowLeft, Bot, ChevronLeft, ChevronRight, MessageSquare, Sparkles, UserRound } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { AgentDefinition, AgentTemplate, AgentVersion } from "@/lib/agent-platform";
import { CreateAgentPageClient } from "./create-agent-page-client";
import { CreateGeneralAgentPageClient } from "./create-general-agent-page-client";

export type AgentCreationAudience = "personal" | "customer_service";
export type AgentCreationKind = "general" | "custom";

type StartStep = "audience" | "kind";

function progressState(step: StartStep, target: StartStep): "active" | "complete" | "pending" {
  if (step === target) return "active";
  if (step === "kind" && target === "audience") return "complete";
  return "pending";
}

function StartProgress({ step }: { step: StartStep }) {
  return (
    <nav aria-label="Creation progress" className="mx-auto mt-8 max-w-2xl">
      <ol className="flex items-start">
        {(["audience", "kind"] as const).map((target, index) => {
          const state = progressState(step, target);
          const label = target === "audience" ? "Audience" : "Starting point";
          return (
            <li key={target} className="flex min-w-0 flex-1 items-start">
              <div className="flex min-w-20 flex-col items-center gap-2">
                <span className={`grid h-9 w-9 place-items-center rounded-full border text-sm font-semibold ${state === "active" ? "border-primary bg-primary text-primary-foreground" : state === "complete" ? "border-status-success bg-status-success text-white" : "border-border bg-secondary text-muted-foreground"}`}>
                  {state === "complete" ? "✓" : index + 1}
                </span>
                <span className={`text-[11px] font-semibold uppercase tracking-[0.12em] ${state === "active" ? "text-primary" : state === "complete" ? "text-status-success" : "text-muted-foreground"}`}>{label}</span>
              </div>
              {index === 0 ? <span className={`mt-[18px] h-px flex-1 ${step === "kind" ? "bg-status-success/60" : "bg-border"}`} aria-hidden="true" /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function AudienceChoice({ audience, selected, onSelect }: { audience: AgentCreationAudience; selected: boolean; onSelect: () => void }) {
  const personal = audience === "personal";
  return (
    <button type="button" aria-pressed={selected} onClick={onSelect} className={`flex min-h-52 flex-col rounded-2xl border p-6 text-left transition-[border-color,background-color,transform] hover:-translate-y-0.5 ${selected ? "border-primary bg-primary/10 shadow-lg shadow-primary/10" : "border-border bg-card hover:border-primary/60 hover:bg-secondary/35"}`}>
      {personal ? <UserRound className="h-6 w-6 text-primary" /> : <MessageSquare className="h-6 w-6 text-primary" />}
      <h2 className="mt-5 text-lg font-semibold text-foreground">{personal ? "Personal agent" : "Customer service agent"}</h2>
      <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{personal ? "Private assistant for your work, knowledge, and everyday tasks." : "Customer-facing assistant for conversations, support, and service workflows."}</p>
      <span className="mt-auto pt-6 text-sm font-medium text-primary">{selected ? "Selected" : "Choose"}</span>
    </button>
  );
}

function KindChoice({ kind, selected, onSelect }: { kind: AgentCreationKind; selected: boolean; onSelect: () => void }) {
  const general = kind === "general";
  return (
    <button type="button" aria-pressed={selected} onClick={onSelect} className={`flex min-h-56 flex-col rounded-2xl border p-6 text-left transition-[border-color,background-color,transform] hover:-translate-y-0.5 ${selected ? "border-primary bg-primary/10 shadow-lg shadow-primary/10" : "border-border bg-card hover:border-primary/60 hover:bg-secondary/35"}`}>
      {general ? <Sparkles className="h-6 w-6 text-primary" /> : <Bot className="h-6 w-6 text-primary" />}
      <h2 className="mt-5 text-lg font-semibold text-foreground">{general ? "General-purpose agent" : "Custom agent"}</h2>
      <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{general ? "Start with a focused role, approved knowledge, and sensible response defaults." : "Build a workflow from a canvas and add tools, knowledge, channels, and services as needed."}</p>
      <span className="mt-auto pt-6 text-sm font-medium text-primary">{selected ? "Selected" : "Choose"}</span>
    </button>
  );
}

function StartScreen({ step, audience, kind, onAudienceChange, onKindChange, onBack, onBackToAudience, onContinue }: { step: StartStep; audience: AgentCreationAudience | null; kind: AgentCreationKind | null; onAudienceChange: (value: AgentCreationAudience) => void; onKindChange: (value: AgentCreationKind) => void; onBack: () => void; onBackToAudience: () => void; onContinue: () => void }) {
  const title = step === "audience" ? "Choose who it will serve" : "Choose a starting point";
  const description = step === "audience" ? "Set the audience before you configure the agent." : "Choose the level of control you need.";
  return (
    <div className="min-h-[100dvh] px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <div className="flex items-center justify-between gap-4">
          <button type="button" onClick={onBack} className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"><ArrowLeft className="h-4 w-4" />Agents</button>
          <Badge className="border-primary/20 bg-primary/10 text-primary">Create agent</Badge>
        </div>
        <StartProgress step={step} />
        <Card className="mt-10 rounded-3xl border-border/80 shadow-xl shadow-black/10">
          <CardContent className="p-6 sm:p-10 lg:p-14">
            <div className="mx-auto max-w-3xl text-center">
              <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/20"><Bot className="h-7 w-7" /></div>
              <h1 className="mt-6 text-2xl font-semibold tracking-tight text-foreground">Create an agent</h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{title}. {description}</p>
            </div>

            {step === "audience" ? (
              <div className="mt-9 grid gap-4 md:grid-cols-2">
                <AudienceChoice audience="personal" selected={audience === "personal"} onSelect={() => onAudienceChange("personal")} />
                <AudienceChoice audience="customer_service" selected={audience === "customer_service"} onSelect={() => onAudienceChange("customer_service")} />
              </div>
            ) : (
              <div className="mt-9 grid gap-4 md:grid-cols-2">
                <KindChoice kind="general" selected={kind === "general"} onSelect={() => onKindChange("general")} />
                <KindChoice kind="custom" selected={kind === "custom"} onSelect={() => onKindChange("custom")} />
              </div>
            )}

            <div className="mt-10 flex items-center justify-between gap-3 border-t border-border pt-6">
              <Button type="button" variant="outline" onClick={step === "audience" ? onBack : onBackToAudience}>{step === "audience" ? "Cancel" : <><ChevronLeft className="mr-1 h-4 w-4" />Back</>}</Button>
              <Button type="button" disabled={step === "audience" ? !audience : !kind} onClick={onContinue}>Continue <ChevronRight className="ml-1 h-4 w-4" /></Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function AgentCreationFlowPageClient({ userId, initialAudience, initialMode, initialTemplate, initialDraft }: { userId?: string; initialAudience?: AgentCreationAudience; initialMode?: AgentCreationKind; initialTemplate?: AgentTemplate; initialDraft?: { agent: AgentDefinition; version: AgentVersion } }) {
  const router = useRouter();
  const [audience, setAudience] = useState<AgentCreationAudience | null>(initialAudience ?? null);
  const [selectedAudience, setSelectedAudience] = useState<AgentCreationAudience | null>(initialAudience ?? null);
  const [kind, setKind] = useState<AgentCreationKind | null>(initialMode ?? null);
  const [selectedKind, setSelectedKind] = useState<AgentCreationKind | null>(initialMode ?? null);
  const [step, setStep] = useState<StartStep>(initialAudience ? "kind" : "audience");
  const returnToKind = () => {
    setKind(null);
    setSelectedKind(null);
    setStep("kind");
  };

  if (audience && kind === "general") {
    return <CreateGeneralAgentPageClient audience={audience} userId={userId} onBackToStart={returnToKind} />;
  }
  if (audience && kind === "custom") {
    return <CreateAgentPageClient audience={audience} userId={userId} initialTemplate={initialTemplate} initialDraft={initialDraft} onBackToStart={returnToKind} />;
  }

  return <StartScreen step={step} audience={selectedAudience} kind={selectedKind} onAudienceChange={setSelectedAudience} onKindChange={setSelectedKind} onBack={() => router.push("/agents")} onBackToAudience={() => { setSelectedKind(null); setKind(null); setStep("audience"); }} onContinue={() => {
    if (step === "audience" && selectedAudience) {
      setAudience(selectedAudience);
      setStep("kind");
      return;
    }
    if (step === "kind" && selectedKind && audience) setKind(selectedKind);
  }} />;
}
