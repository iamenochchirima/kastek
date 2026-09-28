"use client";

import { useState } from "react";
import { ArrowLeft, Bot, LoaderCircle, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { createStudioAgent } from "@/lib/agent-platform";

const defaultInstructions = "You are an autonomous workspace assistant. Plan the user's request, use only authorized capabilities, and clearly report what you completed.";

export function StudioAgentCreationPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState(defaultInstructions);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!name.trim() || !instructions.trim() || submitting) return;
    setSubmitting(true);
    try {
      const created = await createStudioAgent({
        name: name.trim(),
        description: description.trim() || undefined,
        instructions: instructions.trim(),
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
              <CardDescription>Creates an autonomous agent with a Playground installation.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div>
                <label htmlFor="studio-agent-name" className="text-sm font-medium text-foreground">Name</label>
                <Input id="studio-agent-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Research assistant" className="mt-2" autoFocus />
              </div>
              <div>
                <label htmlFor="studio-agent-description" className="text-sm font-medium text-foreground">Purpose <span className="font-normal text-muted-foreground">(optional)</span></label>
                <Input id="studio-agent-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this agent is responsible for" className="mt-2" />
              </div>
              <div>
                <label htmlFor="studio-agent-instructions" className="text-sm font-medium text-foreground">Instructions</label>
                <Textarea id="studio-agent-instructions" value={instructions} onChange={(event) => setInstructions(event.target.value)} className="mt-2 min-h-48 resize-y" />
              </div>
              <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-5">
                <Button type="button" variant="outline" onClick={() => router.push("/studio")} disabled={submitting}>Cancel</Button>
                <Button type="button" onClick={() => void submit()} disabled={submitting || !name.trim() || !instructions.trim()}>
                  {submitting ? <LoaderCircle className="mr-1.5 size-4 animate-spin" /> : <Sparkles className="mr-1.5 size-4" />}
                  {submitting ? "Creating…" : "Create agent"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
