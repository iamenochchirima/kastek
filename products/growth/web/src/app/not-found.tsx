import { Link } from "react-router";
import { ArrowLeft, SearchX } from "lucide-react";
import { MotionReveal } from "@/components/ui/motion-reveal";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-background px-4 py-12 text-foreground">
      <MotionReveal className="w-full max-w-md">
        <section aria-labelledby="not-found-title" className="rounded-xl border border-border bg-card p-6 text-center shadow-[var(--shadow-panel)] sm:p-8">
          <div className="mx-auto grid size-11 place-items-center rounded-full bg-primary/10 text-primary">
            <SearchX className="size-5" aria-hidden="true" />
          </div>
          <p className="mt-5 text-xs font-semibold uppercase tracking-[0.16em] text-primary">404</p>
          <h1 id="not-found-title" className="mt-2 text-2xl font-semibold tracking-tight">Page not found</h1>
          <p className="mt-2 text-sm text-muted-foreground">The page may have moved or no longer exists.</p>
          <Button asChild className="mt-6">
            <Link to="/workspace"><ArrowLeft className="size-4" />Back to workspace</Link>
          </Button>
        </section>
      </MotionReveal>
    </main>
  );
}
