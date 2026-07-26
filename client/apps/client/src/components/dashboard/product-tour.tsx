"use client";

import type { ProductTourStatus } from "@/lib/product-tour";
import { apiUrl } from "@/lib/server-api";
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
    goalStep(goal),
    { target: "connections", eyebrow: "Set up", title: "Connect your channels", description: "Connect WhatsApp and other available channels before working with real customer conversations." },
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
  const [busy, setBusy] = useState(false);
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
      void (async () => {
        setBusy(true);
        try {
          await updateTour("restart", 0);
          setStepIndex(0);
          setOpen(true);
        } finally {
          setBusy(false);
        }
      })();
    };
    window.addEventListener("kasitek:restart-product-tour", restart);
    return () => window.removeEventListener("kasitek:restart-product-tour", restart);
  }, []);

  if (!open || !step) return null;
  const isLast = stepIndex === steps.length - 1;
  const viewportHeight = typeof window === "undefined" ? 800 : window.innerHeight;
  const popoverTop = targetRect ? Math.min(Math.max(16, targetRect.top + targetRect.height / 2 - 132), viewportHeight - 280) : 24;
  const popoverLeft = targetRect ? Math.min(targetRect.right + 20, typeof window === "undefined" ? 320 : window.innerWidth - 372) : 24;

  async function dismiss() {
    setBusy(true);
    try {
      await updateTour("dismiss", stepIndex);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  async function next() {
    setBusy(true);
    try {
      if (isLast) {
        await updateTour("complete", stepIndex);
        setOpen(false);
        return;
      }
      const nextIndex = stepIndex + 1;
      await updateTour(stepIndex === 0 ? "start" : "advance", nextIndex);
      setStepIndex(nextIndex);
    } finally {
      setBusy(false);
    }
  }

  function previous() {
    setStepIndex((current) => Math.max(0, current - 1));
  }

  return (
    <div className="fixed inset-0 z-[100] pointer-events-none" aria-live="polite">
      {!compact && targetRect ? <div className="fixed rounded-lg border-2 border-primary/80 bg-transparent transition-[top,left,width,height] duration-500 ease-out" style={{ top: targetRect.top - 6, left: targetRect.left - 6, width: targetRect.width + 12, height: targetRect.height + 12, boxShadow: "0 0 0 9999px rgba(5, 7, 10, 0.64)" }} /> : <div className="fixed inset-0 bg-foreground/65" />}
      <section className={`pointer-events-auto fixed w-[min(360px,calc(100vw-2rem))] rounded-xl border border-border bg-card p-5 text-foreground shadow-2xl transition-all duration-500 ease-out ${compact || !targetRect ? "bottom-4 left-1/2 -translate-x-1/2" : ""}`} style={compact || !targetRect ? undefined : { top: popoverTop, left: popoverLeft }} role="dialog" aria-modal="true" aria-label="KasiTek product tour">
        {!compact && targetRect ? <span className="absolute -left-2 top-1/2 h-4 w-4 -translate-y-1/2 rotate-45 border-b border-l border-border bg-card" /> : null}
        <div className="relative flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">{step.eyebrow}</p>
            <h2 className="mt-2 text-lg font-semibold tracking-tight">{step.title}</h2>
          </div>
          <button type="button" onClick={() => void dismiss()} disabled={busy} className="rounded-md p-1.5 text-muted-foreground transition hover:bg-secondary hover:text-foreground" aria-label="Skip tour"><X className="h-4 w-4" /></button>
        </div>
        <p className="relative mt-3 text-sm leading-6 text-muted-foreground">{step.description}</p>
        <div className="relative mt-5 flex gap-1.5" aria-label={`Tour step ${stepIndex + 1} of ${steps.length}`}>{steps.map((item, index) => <span key={item.target} className={`h-1 flex-1 rounded-full transition-colors ${index <= stepIndex ? "bg-primary" : "bg-secondary"}`} />)}</div>
        <div className="relative mt-5 flex items-center justify-between gap-3">
          {stepIndex > 0 ? <button type="button" onClick={previous} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"><ArrowLeft className="h-4 w-4" />Back</button> : <button type="button" onClick={() => void dismiss()} disabled={busy} className="px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground">Skip tour</button>}
          <button type="button" onClick={() => void next()} disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50">{isLast ? "Finish" : "Next"}{isLast ? <Check className="h-4 w-4" /> : <ArrowRight className="h-4 w-4" />}</button>
        </div>
      </section>
    </div>
  );
}
