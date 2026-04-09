import type { Metadata } from "next";
import { Check, MessageSquareQuote } from "lucide-react";
import { Footer } from "@/components/landing/Footer";
import { Navbar } from "@/components/landing/Navbar";
import QuoteRequestForm from "@/components/quote/quote-request-form";

export const metadata: Metadata = {
  title: "Get a Quote | KasiTek",
  description:
    "Request a tailored quote for KasiTek products, AI agents, automation systems, and custom implementation work.",
};

const quoteHighlights = [
  "Tell us what you want to automate or improve",
  "Choose products, services, or a mix of both",
  "Get a tailored rollout recommendation and quote",
];

export default function GetQuotePage() {
  return (
    <main className="relative min-h-screen w-full selection:bg-primary/30 selection:text-primary">
      <div className="bg-noise" />
      <Navbar />

      <section className="relative overflow-hidden px-6 pb-16 pt-32 md:px-12 md:pb-24 md:pt-40">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(232,160,32,0.12),transparent_42%)]" />
        <div className="relative mx-auto max-w-7xl">
          <div className="grid gap-10 border-t border-border/50 pt-8 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:items-start">
            <div className="max-w-2xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/8 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
                <MessageSquareQuote className="h-3.5 w-3.5" />
                Get a Quote
              </div>

              <h1 className="mt-6 font-display text-5xl leading-[0.9] tracking-tight text-foreground sm:text-6xl md:text-8xl">
                Tell us what service you need. We&apos;ll scope the right solution.
              </h1>

              <p className="mt-6 max-w-xl text-base leading-relaxed text-muted-foreground md:text-lg">
                Use this form to request a quote for custom services and implementation work.
              </p>

              <div className="mt-8 hidden rounded-[28px] border border-border bg-card/45 p-6 backdrop-blur-sm lg:block">
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-primary">
                  What happens next
                </p>
                <div className="mt-5 space-y-4">
                  {quoteHighlights.map((item) => (
                    <div key={item} className="flex items-start gap-3">
                      <div className="mt-0.5 rounded-full border border-primary/20 bg-primary/10 p-1">
                        <Check className="h-3.5 w-3.5 text-primary" />
                      </div>
                      <p className="text-sm leading-6 text-muted-foreground">{item}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="rounded-[28px] border border-border bg-card/55 p-3 shadow-[0_18px_60px_rgba(0,0,0,0.32)] backdrop-blur-sm sm:p-4 md:rounded-[32px] md:p-6">
              <QuoteRequestForm />
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </main>
  );
}
