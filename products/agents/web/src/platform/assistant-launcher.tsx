import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { AiChat02Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { api, organizationPath, type Agent } from "./api";
import { Chat } from "./chat";

type Assistant = { state: "absent" | "draft" | "configured" | "deleted"; agent: Agent | null };

/**
 * Floating entry point for the workspace assistant.
 * The assistant is a system helper, so it lives outside the agent catalogue and gets its own surface.
 */
export function AssistantLauncher({ organizationId, accountId, hidden = false }: { organizationId: string; accountId: string; hidden?: boolean }) {
  const [assistant, setAssistant] = useState<Assistant | null>(null);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    api<Assistant>(`${organizationPath(organizationId)}/assistant`)
      .then(result => { if (live) setAssistant(result); })
      .catch(() => { if (live) setAssistant(null); });
    return () => { live = false; };
  }, [organizationId]);

  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector('[data-slot="dialog-content"]')) return;
      close();
    };
    document.addEventListener("keydown", onKeyDown);
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus());
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  const agentId = assistant?.agent?.id ?? null;
  const available = assistant?.state === "configured" && Boolean(agentId);
  if (hidden || !available) return null;

  return <>
    {!open ? <button
      ref={trigger}
      type="button"
      aria-label="Open assistant"
      title="Open assistant"
      onClick={() => setOpen(true)}
      className="fixed bottom-5 right-5 z-30 grid size-14 place-items-center rounded-full border border-border bg-primary text-primary-foreground shadow-sm transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:bottom-6 sm:right-6"
    >
      <HugeiconsIcon icon={AiChat02Icon} size={24} aria-hidden="true" />
    </button> : null}
    {open ? createPortal(
      <div className="fixed inset-0 z-40" role="presentation">
        <div className="absolute inset-0 bg-black/40" onClick={close} aria-hidden="true" />
        <div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-label="Assistant"
          className="absolute inset-x-0 bottom-0 top-0 flex flex-col overflow-hidden border border-border bg-background shadow-lg sm:inset-auto sm:bottom-6 sm:right-6 sm:top-auto sm:h-[min(720px,calc(100dvh-48px))] sm:w-[420px] sm:rounded-lg"
        >
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground"><HugeiconsIcon icon={AiChat02Icon} size={16} aria-hidden="true" /></span>
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{assistant?.agent?.name ?? "Assistant"}</h2>
            <Button type="button" size="icon" variant="ghost" onClick={close} aria-label="Close assistant">
              <HugeiconsIcon icon={Cancel01Icon} size={18} aria-hidden="true" />
            </Button>
          </header>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <Chat
              endpoint={`${organizationPath(organizationId)}/tasks`}
              storageKey={`agents.assistant.${accountId}.${organizationId}`}
              agentId={agentId!}
              expectedAgentId={agentId!}
              cancellable
            />
          </div>
        </div>
      </div>,
      document.body,
    ) : null}
  </>;
}
