"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { AgentConversation } from "./agent-conversation";
import { useGrowthAgents } from "./agent-provider";

function subscribe(callback: () => void) { const query = window.matchMedia("(min-width: 1280px)"); query.addEventListener("change", callback); return () => query.removeEventListener("change", callback); }
const snapshot = () => window.matchMedia("(min-width: 1280px)").matches;

export function GrowthAssistantDock() {
  const { panelOpen, closePanel, setPanelOpen } = useGrowthAgents();
  const desktop = useSyncExternalStore(subscribe, snapshot, () => false);
  const previousFocus = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!panelOpen || !desktop) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus());
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !document.querySelector('[data-slot="dialog-content"]')) closePanel(); };
    document.addEventListener("keydown", close);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("keydown", close); if (previousFocus.current?.isConnected) previousFocus.current.focus(); };
  }, [panelOpen, closePanel, desktop]);
  if (desktop) return panelOpen ? <aside ref={panel} aria-label="Growth assistant" className="sticky top-0 z-20 h-[100dvh] w-[420px] shrink-0 self-start border-l border-border 2xl:w-[460px]"><AgentConversation onClose={closePanel} /></aside> : null;
  return <Dialog open={panelOpen} onOpenChange={setPanelOpen}><DialogContent showCloseButton={false} className="dashboard-theme inset-0 left-0 top-0 flex h-[100dvh] max-h-[100dvh] w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:max-w-none"><DialogTitle className="sr-only">Growth assistant</DialogTitle><DialogDescription className="sr-only">Agent conversation</DialogDescription><AgentConversation onClose={closePanel} /></DialogContent></Dialog>;
}
