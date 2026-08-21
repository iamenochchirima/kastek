"use client";

import type { ProductTourStatus } from "@/lib/product-tour";
import { apiUrl } from "@/lib/server-api";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ArrowRight, Check, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type TourStep = {
  target: string;
  eyebrow: string;
  title: string;
  description: string;
};

function goalStep(goal: string | null): TourStep {
  const steps: Record<string, TourStep> = {
    messages: { target: "inbox", eyebrow: "Customer conversations", title: "Your customer inbox", description: "This is where your team can manage customer messages from connected channels." },
    agents: { target: "agents", eyebrow: "Automation", title: "AI agents", description: "Create and manage agents here when you are ready to automate answers and lead capture." },
    content: { target: "content", eyebrow: "Growth", title: "Content", description: "Plan, schedule and publish multi-platform content from this workspace." },
    bookings: { target: "bookings", eyebrow: "Growth", title: "Bookings", description: "Set up services and give customers a simple way to schedule with you." },
    campaigns: { target: "campaigns", eyebrow: "Growth", title: "Campaigns", description: "Send approved WhatsApp campaigns to contacts who have opted in." },
  };
  return steps[goal ?? ""] ?? { target: "overview", eyebrow: "Home", title: "Your workspace overview", description: "Return here for a clear view of the workspace and what needs attention." };
}

function buildSteps(goal: string | null): TourStep[] {
  const steps = [
    { target: "workspace-switcher", eyebrow: "Workspace", title: "Switch workspaces here", description: "Use this control to move between the workspaces you belong to without signing out." },
    { target: "sidebar-toggle", eyebrow: "Navigation", title: "Make more room when you need it", description: "Collapse the sidebar to focus on your work, then expand it again whenever you need the full navigation." },
    { target: "theme", eyebrow: "Appearance", title: "Choose the theme that suits you", description: "Switch between light and dark mode at any time. Your preference is remembered." },
    { target: "profile", eyebrow: "Your account", title: "Your profile and account menu", description: "Open this menu for your profile, team access, and sign-out controls." },
    { target: "workspace-settings", eyebrow: "Manage", title: "Workspace settings", description: "Manage workspace-level settings here as your business grows." },
    goalStep(goal),
    { target: "connections", eyebrow: "Set up", title: "Connect your channels", description: "Connect WhatsApp, Facebook, Instagram, LinkedIn, X, and any other available channels before working with real customer conversations." },
    { target: "inbox", eyebrow: "Customer conversations", title: "Keep messages in one place", description: "Use the inbox to reply, assign conversations, and keep the right context with every customer." },
    { target: "team", eyebrow: "Manage", title: "Invite your team", description: "Add the people who will use the workspace and give them the right access." },
    { target: "overview", eyebrow: "Home", title: "Come back to your overview", description: "Use Overview whenever you want a quick picture of activity and your next action." },
  ];
  return steps.filter((step, index, items) => items.findIndex((item) => item.target === step.target) === index);
}

async function updateTour(action: string, currentStep?: number) {
  const response = await fetch(apiUrl("/api/product-tour"), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action, currentStep }),
  });
  if (!response.ok) throw new Error("Could not update the product tour");
}

export function ProductTour({ status }: { status: ProductTourStatus | null }) {
  const steps = useMemo(() => buildSteps(status?.primaryGoal ?? null), [status?.primaryGoal]);
  const [open, setOpen] = useState(Boolean(status?.shouldShow));
  const [stepIndex, setStepIndex] = useState(Math.min(status?.currentStep ?? 0, steps.length - 1));
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [compact, setCompact] = useState(false);
  const step = steps[stepIndex];

  const measureTarget = useCallback(() => {
    const target = document.querySelector<HTMLElement>(`[data-tour="${step?.target}"]`);
    setTargetRect(target?.getBoundingClientRect() ?? null);
    setCompact(window.innerWidth < 1024);
  }, [step?.target]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(measureTarget);
    window.addEventListener("resize", measureTarget);
    window.addEventListener("scroll", measureTarget, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", measureTarget);
      window.removeEventListener("scroll", measureTarget, true);
    };
  }, [open, measureTarget]);

  useEffect(() => {
    const restart = () => {
      setStepIndex(0);
      setOpen(true);
      void updateTour("restart", 0).catch(() => undefined);
    };
    window.addEventListener("kasitek:restart-product-tour", restart);
    return () => window.removeEventListener("kasitek:restart-product-tour", restart);
  }, []);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      void updateTour("dismiss", stepIndex).catch(() => undefined);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, stepIndex]);

  if (!open || !step) return null;
  const isLast = stepIndex === steps.length - 1;
  const viewportHeight = typeof window === "undefined" ? 800 : window.innerHeight;
  const popoverTop = targetRect ? Math.min(Math.max(16, targetRect.top + targetRect.height / 2 - 132), viewportHeight - 280) : 24;
  const popoverLeft = targetRect ? Math.min(targetRect.right + 20, typeof window === "undefined" ? 320 : window.innerWidth - 372) : 24;

  function dismiss() {
    setOpen(false);
    void updateTour("dismiss", stepIndex).catch(() => undefined);
  }

  function next() {
    if (isLast) {
      setOpen(false);
      void updateTour("complete", stepIndex).catch(() => undefined);
      return;
    }
    const nextIndex = stepIndex + 1;
    setStepIndex(nextIndex);
    void updateTour(stepIndex === 0 ? "start" : "advance", nextIndex).catch(() => undefined);
  }

  function previous() {
    setStepIndex((current) => Math.max(0, current - 1));
  }

  return (
    <div className="pointer-events-none fixed inset-0 z-[var(--z-tour)]" aria-live="polite">
      {!compact && targetRect ? <div className="fixed rounded-lg border-2 border-primary/80 bg-transparent transition-[top,left,width,height] duration-500 ease-out" style={{ top: targetRect.top - 6, left: targetRect.left - 6, width: targetRect.width + 12, height: targetRect.height + 12, boxShadow: "0 0 0 9999px rgba(5, 7, 10, 0.64)" }} /> : <div className="fixed inset-0 bg-foreground/65" />}
      <section className={`pointer-events-auto fixed max-h-[calc(100dvh-2rem)] w-[min(360px,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-border bg-card p-5 text-foreground shadow-2xl transition-all duration-[var(--v-motion-shell)] ease-out ${compact || !targetRect ? "bottom-4 left-1/2 -translate-x-1/2" : ""}`} style={compact || !targetRect ? undefined : { top: popoverTop, left: popoverLeft }} role="dialog" aria-modal="true" aria-label="KasiTek product tour">
        {!compact && targetRect ? <span className="absolute -left-2 top-1/2 h-4 w-4 -translate-y-1/2 rotate-45 border-b border-l border-border bg-card" /> : null}
        <div className="relative flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">{step.eyebrow}</p>
            <h2 className="mt-2 text-lg font-semibold tracking-tight">{step.title}</h2>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">Step {stepIndex + 1} of {steps.length}</span>
            <Button type="button" variant="ghost" size="icon-sm" onClick={dismiss} aria-label="Skip tour"><X className="h-4 w-4" /></Button>
          </div>
        </div>
        <p className="relative mt-3 text-sm leading-6 text-muted-foreground">{step.description}</p>
        <div className="relative mt-5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-1">
            {stepIndex > 0 ? <Button type="button" variant="ghost" size="sm" onClick={previous}><ArrowLeft className="h-4 w-4" />Back</Button> : null}
            <Button type="button" variant="ghost" size="sm" onClick={dismiss}>Skip tour</Button>
          </div>
          <Button type="button" onClick={next}>{isLast ? "Finish" : "Next"}{isLast ? <Check className="h-4 w-4" /> : <ArrowRight className="h-4 w-4" />}</Button>
        </div>
      </section>
    </div>
  );
}
