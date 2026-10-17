"use client";

import { useRef, useState } from "react";
import { ArrowLeft, Bot, LoaderCircle, Sparkles } from "lucide-react";
import { useRouter } from "@/lib/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { createStudioAgent } from "@/lib/agent-platform";

const defaultInstructions = "You are the support assistant for this business. Answer from the approved knowledge connected to you. If you do not know, say so and suggest contacting the business directly. Do not claim to have captured an enquiry or completed an action unless the system confirms it.";

export function StudioAgentCreationPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState(defaultInstructions);
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<{ field: "name" | "instructions"; message: string } | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const instructionsInput = useRef<HTMLTextAreaElement>(null);
  const submit = async () => {
    if (submitting) return;
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
      const created = await createStudioAgent({
        name: name.trim(),
        description: description.trim() || undefined,
        instructions: instructions.trim(),
      });
      router.push(`/app/agents/${encodeURIComponent(created.agent.id)}?section=configuration`);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Unable to create the agent");
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-[calc(100dvh-4rem)] bg-canvas">
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-10 lg:py-12">
        <Button type="button" variant="ghost" size="sm" className="-ml-2 gap-1.5 text-muted-foreground" onClick={() => router.push("/app/agents")}>
          <ArrowLeft className="size-4" />Agents
        </Button>

        <div className="mt-8 max-w-2xl">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2 text-primary"><Bot className="size-4" /><span className="text-[10px] font-semibold uppercase tracking-[0.16em]">Business agent</span></div>
              <CardTitle className="text-2xl tracking-tight">Create a support assistant</CardTitle>
              <CardDescription>This saves a private draft for you to configure and test. It will not appear on your website until you publish it.</CardDescription>
            </CardHeader>
            <CardContent><form className="space-y-5" onSubmit={event => { event.preventDefault(); void submit(); }}>
              <div>
                <label htmlFor="studio-agent-name" className="text-sm font-medium text-foreground">Name</label>
                <Input id="studio-agent-name" ref={nameInput} required maxLength={160} aria-invalid={validationError?.field === "name"} aria-describedby={validationError?.field === "name" ? "studio-agent-validation" : undefined} disabled={submitting} value={name} onChange={(event) => { setName(event.target.value); setValidationError(null); }} placeholder="Customer support assistant" className="mt-2" autoFocus />
              </div>
              <div>
                <label htmlFor="studio-agent-description" className="text-sm font-medium text-foreground">What should it help customers with? <span className="font-normal text-muted-foreground">(optional)</span></label>
                <Input id="studio-agent-description" maxLength={2000} disabled={submitting} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Answer questions about your products, services, and policies" className="mt-2" />
              </div>
              <div>
                <label htmlFor="studio-agent-instructions" className="text-sm font-medium text-foreground">How should it respond?</label>
                <Textarea id="studio-agent-instructions" ref={instructionsInput} required maxLength={200000} aria-invalid={validationError?.field === "instructions"} aria-describedby={validationError?.field === "instructions" ? "studio-agent-validation" : undefined} disabled={submitting} value={instructions} onChange={(event) => { setInstructions(event.target.value); setValidationError(null); }} className="mt-2 min-h-48 resize-y" />
              </div>
              {validationError ? <p id="studio-agent-validation" role="alert" className="text-sm text-destructive">{validationError.message}</p> : null}
              <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-5">
                <Button type="button" variant="outline" onClick={() => router.push("/app/agents")} disabled={submitting}>Cancel</Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? <LoaderCircle className="mr-1.5 size-4 animate-spin" /> : <Sparkles className="mr-1.5 size-4" />}
                  {submitting ? "Creating…" : "Create draft"}
                </Button>
              </div>
            </form></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
