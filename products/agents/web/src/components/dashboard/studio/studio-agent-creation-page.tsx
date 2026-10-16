"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Bot, LoaderCircle, Sparkles } from "lucide-react";
import { useRouter } from "@/lib/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { createStudioAgent, getAgentModelCatalog, AGENT_MODEL_PROVIDER_LABELS, type AgentModel } from "@/lib/agent-platform";

const defaultInstructions = "You are an autonomous workspace assistant. Plan the user's request, use only authorized capabilities, and clearly report what you completed.";

export function StudioAgentCreationPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState(defaultInstructions);
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<{ field: "name" | "instructions"; message: string } | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const instructionsInput = useRef<HTMLTextAreaElement>(null);
  const [models, setModels] = useState<AgentModel[]>([]);
  const [modelKey, setModelKey] = useState("");
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void getAgentModelCatalog().then(result => {
      if (cancelled) return;
      setModels(result.models);
      const selected = result.models.find(model => model.isWorkspaceDefault) ?? result.models[0];
      if (selected) setModelKey(`${selected.provider}:${selected.model}`);
    }).catch(() => { if (!cancelled) setModelsError(true); })
      .finally(() => { if (!cancelled) setModelsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const submit = async () => {
    if (submitting || modelsLoading) return;
    if (!name.trim()) {
      setValidationError({ field: "name", message: "Enter a name for this agent." });
      nameInput.current?.focus();
      return;
    }
    if (!instructions.trim()) {
      setValidationError({ field: "instructions", message: "Add instructions describing what this agent should do." });
      instructionsInput.current?.focus();
      return;
    }
    setValidationError(null);
    setSubmitting(true);
    try {
      const selected = models.find(model => `${model.provider}:${model.model}` === modelKey);
      const created = await createStudioAgent({
        name: name.trim(),
        description: description.trim() || undefined,
        instructions: instructions.trim(),
        ...(selected ? { modelProvider: selected.provider, model: selected.model } : {}),
      });
      router.push(`/studio?agent=${encodeURIComponent(created.agent.id)}`);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Unable to create the agent");
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-[calc(100dvh-4rem)] bg-canvas">
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-10 lg:py-12">
        <Button type="button" variant="ghost" size="sm" className="-ml-2 gap-1.5 text-muted-foreground" onClick={() => router.push("/studio")}>
          <ArrowLeft className="size-4" />Studio
        </Button>

        <div className="mt-8 max-w-2xl">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2 text-primary"><Bot className="size-4" /><span className="text-[10px] font-semibold uppercase tracking-[0.16em]">Studio setup</span></div>
              <CardTitle className="text-2xl tracking-tight">Create agent</CardTitle>
              <CardDescription>Create a hosted agent with a playground to try its instructions.</CardDescription>
            </CardHeader>
            <CardContent><form className="space-y-5" onSubmit={event => { event.preventDefault(); void submit(); }}>
              <div>
                <label htmlFor="studio-agent-name" className="text-sm font-medium text-foreground">Name</label>
                <Input id="studio-agent-name" ref={nameInput} required maxLength={160} aria-invalid={validationError?.field === "name"} aria-describedby={validationError?.field === "name" ? "studio-agent-validation" : undefined} disabled={submitting} value={name} onChange={(event) => { setName(event.target.value); setValidationError(null); }} placeholder="Research assistant" className="mt-2" autoFocus />
              </div>
              <div>
                <label htmlFor="studio-agent-description" className="text-sm font-medium text-foreground">Purpose <span className="font-normal text-muted-foreground">(optional)</span></label>
                <Input id="studio-agent-description" maxLength={2000} disabled={submitting} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this agent is responsible for" className="mt-2" />
              </div>
              <div>
                <label htmlFor="studio-agent-model" className="text-sm font-medium text-foreground">Model</label>
                <select id="studio-agent-model" value={modelKey} onChange={event => setModelKey(event.target.value)} disabled={modelsLoading || submitting || !models.length} className="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                  {!models.length && <option value="">{modelsLoading ? "Loading models…" : "Workspace default"}</option>}
                  {models.map(model => <option key={`${model.provider}:${model.model}`} value={`${model.provider}:${model.model}`}>{model.label}{model.label !== model.model ? ` (${model.model})` : ""} · {AGENT_MODEL_PROVIDER_LABELS[model.provider]}{model.isWorkspaceDefault ? " · Default" : ""}</option>)}
                </select>
                {modelsError && <p role="status" className="mt-2 text-xs text-muted-foreground">The model list is unavailable. Your workspace default will be used.</p>}
              </div>
              <div>
                <label htmlFor="studio-agent-instructions" className="text-sm font-medium text-foreground">Instructions</label>
                <Textarea id="studio-agent-instructions" ref={instructionsInput} required maxLength={200000} aria-invalid={validationError?.field === "instructions"} aria-describedby={validationError?.field === "instructions" ? "studio-agent-validation" : undefined} disabled={submitting} value={instructions} onChange={(event) => { setInstructions(event.target.value); setValidationError(null); }} className="mt-2 min-h-48 resize-y" />
              </div>
              {validationError ? <p id="studio-agent-validation" role="alert" className="text-sm text-destructive">{validationError.message}</p> : null}
              <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-5">
                <Button type="button" variant="outline" onClick={() => router.push("/studio")} disabled={submitting}>Cancel</Button>
                <Button type="submit" disabled={submitting || modelsLoading}>
                  {submitting ? <LoaderCircle className="mr-1.5 size-4 animate-spin" /> : <Sparkles className="mr-1.5 size-4" />}
                  {submitting ? "Creating…" : "Create agent"}
                </Button>
              </div>
            </form></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
