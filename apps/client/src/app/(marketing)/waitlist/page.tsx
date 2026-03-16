import type { Metadata } from "next";
import { Check, Clock3 } from "lucide-react";
import { Footer } from "@/components/landing/Footer";
import { Navbar } from "@/components/landing/Navbar";
import ProductWaitlistForm from "@/components/waitlist/product-waitlist-form";

export const metadata: Metadata = {
  title: "Waitlist | KasiTek",
  description:
    "Join the waitlist for KasiTek products and get notified when early access and rollout slots open.",
};

const highlights = [
  "Register interest for KasiAgents, KasiReach, or KasiSocial",
  "Tell us which plan or product fits your business",
  "Get notified when access opens or rollout slots become available",
];

export default function WaitlistPage() {
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
                <Clock3 className="h-3.5 w-3.5" />
                Product Waitlist
              </div>

              <h1 className="mt-6 font-display text-5xl leading-[0.9] tracking-tight text-foreground sm:text-6xl md:text-8xl">
                Join the waitlist for KasiTek products.
              </h1>

              <p className="mt-6 max-w-xl text-base leading-relaxed text-muted-foreground md:text-lg">
                Our subscription products are still rolling out. Join the waitlist and we&apos;ll
                contact you when early access, launch batches, or onboarding slots open.
              </p>

              <div className="mt-8 rounded-[28px] border border-border bg-card/45 p-6 backdrop-blur-sm">
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-primary">
                  What this is for
                </p>
                <div className="mt-5 space-y-4">
                  {highlights.map((item) => (
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

            <div className="rounded-[32px] border border-border bg-card/55 p-4 shadow-[0_18px_60px_rgba(0,0,0,0.32)] backdrop-blur-sm md:p-6">
              <div className="rounded-[26px] border border-white/8 bg-black/20 p-5 md:p-6">
                <ProductWaitlistForm />
              </div>
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </main>
  );
}
