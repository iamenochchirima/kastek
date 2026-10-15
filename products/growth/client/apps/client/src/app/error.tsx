"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { MotionReveal } from "@/components/ui/motion-reveal";
import { Button } from "@/components/ui/button";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Keep the error boundary quiet in production while preserving a useful dev trace.
    if (process.env.NODE_ENV !== "production") console.error("Unhandled application error", error);
  }, [error]);

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-background px-4 py-12 text-foreground">
      <MotionReveal className="w-full max-w-md">
        <section aria-labelledby="error-title" className="rounded-xl border border-border bg-card p-6 text-center shadow-[var(--shadow-panel)] sm:p-8">
          <div className="mx-auto grid size-11 place-items-center rounded-full bg-status-danger-soft text-destructive">
            <AlertTriangle className="size-5" aria-hidden="true" />
          </div>
          <p className="mt-5 text-xs font-semibold uppercase tracking-[0.16em] text-destructive">Something went wrong</p>
          <h1 id="error-title" className="mt-2 text-2xl font-semibold tracking-tight">We couldn&apos;t load this page</h1>
          <p className="mt-2 text-sm text-muted-foreground">Try again, or return to your workspace.</p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Button type="button" onClick={reset}><RefreshCw className="size-4" />Try again</Button>
            <Button asChild variant="outline"><Link href="/workspace">Back to workspace</Link></Button>
          </div>
        </section>
      </MotionReveal>
    </main>
  );
}
