"use client";

import { useRef, useState, useEffect } from "react";
import Link from "next/link";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";
import { solutionCategories } from "./data";
import {
  BriefcaseBusiness,
  Building2,
  Layers3,
  Store,
  ArrowRight,
} from "lucide-react";

function useInView(threshold = 0.1) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setInView(true); },
      { threshold }
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [threshold]);
  return { ref, inView };
}

function Reveal({ children, className = "", delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  const { ref, inView } = useInView();
  return (
    <div
      ref={ref}
      className={`transition-all duration-700 ${inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"} ${className}`}
      style={{ transitionDelay: inView ? `${delay}ms` : "0ms" }}
    >
      {children}
    </div>
  );
}

const BRAND = {
  accent: "#E8A020",
  accentDim: "rgba(232,160,32,0.07)",
  accentBorder: "rgba(232,160,32,0.25)",
  accentText: "text-[#E8A020]",
};

const CARD_CONFIG = {
  smbs: {
    ...BRAND,
    label: "SMBs",
    headline: "Run your business on autopilot.",
    pitch: "WhatsApp AI, website chat, bookings, and quotations — ready to deploy for any business that needs to respond faster and convert more.",
    icon: BriefcaseBusiness,
  },
  agencies: {
    ...BRAND,
    label: "Agencies & Consultants",
    headline: "Deliver AI for your clients, under your brand.",
    pitch: "White-label AI services, branded client dashboards, content engines, and campaign automations — yours to package and sell.",
    icon: Building2,
  },
  "software-vendors": {
    ...BRAND,
    label: "Software Vendors",
    headline: "Add AI features to your product.",
    pitch: "Embedded conversation layers, branded AI features, usage reporting, and provisioning flows that slot into your existing platform.",
    icon: Layers3,
  },
  franchises: {
    ...BRAND,
    label: "Franchises & Multi-Location",
    headline: "Consistent AI across every branch.",
    pitch: "One communication system with branch-aware routing, centralised campaigns, and cross-location reporting.",
    icon: Store,
  },
};

export default function SolutionsPage() {
  return (
    <main className="relative min-h-screen w-full bg-background text-foreground">
      <Navbar />

      {/* ── Hero ── */}
      <section className="relative flex items-center overflow-hidden px-6 pb-16 pt-36 md:px-12 md:pt-44">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.025]"
          style={{
            backgroundImage: "radial-gradient(circle, #E8A020 1px, transparent 1px)",
            backgroundSize: "28px 28px",
          }}
        />
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse at 30% 60%, rgba(61,186,122,0.06) 0%, transparent 50%), radial-gradient(ellipse at 80% 10%, rgba(232,160,32,0.06) 0%, transparent 45%)",
          }}
        />

        <div className="relative z-10 mx-auto max-w-5xl text-center">
          <Reveal>
            <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-[#E8A020]/20 bg-[#E8A020]/5 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#E8A020]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#E8A020] animate-pulse" />
              Solutions
            </span>
          </Reveal>

          <Reveal delay={60}>
            <h1 className="font-display text-6xl leading-none sm:text-7xl md:text-8xl mb-5">
              Built for<br />
              <span className="text-[#E8A020]">how you work.</span>
            </h1>
          </Reveal>

          <Reveal delay={120}>
            <p className="mx-auto max-w-xl text-base leading-relaxed text-muted-foreground md:text-lg">
              Pick the path that fits your business model. Every category is a different way to deploy the same AI infrastructure — shaped around your role and your clients.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ── Category Cards ── */}
      <section className="px-6 pb-28 md:px-12">
        <div className="mx-auto max-w-6xl">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {solutionCategories.map((category, i) => {
              const config = CARD_CONFIG[category.slug as keyof typeof CARD_CONFIG];
              if (!config) return null;
              const Icon = config.icon;
              const isComingSoon = category.readiness === "coming-soon";

              return (
                <Reveal key={category.slug} delay={i * 80}>
                  <Link
                    href={`/solutions/${category.slug}`}
                    className="group relative flex h-full flex-col overflow-hidden rounded-2xl border border-white/8 bg-[#0D0D0D] p-7 transition-all duration-300 hover:border-white/14 hover:bg-[#111111] md:p-8"
                  >
                    {/* Accent glow */}
                    <div
                      className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100"
                      style={{
                        background: `radial-gradient(ellipse at 30% 30%, ${config.accentDim} 0%, transparent 65%)`,
                      }}
                    />

                    {/* Top accent bar */}
                    <div
                      className="absolute inset-x-0 top-0 h-[2px] origin-left scale-x-0 transition-transform duration-500 ease-out group-hover:scale-x-100"
                      style={{ background: `linear-gradient(90deg, ${config.accent}, transparent)` }}
                    />

                    <div className="relative z-10 flex flex-1 flex-col">
                      {/* Header row */}
                      <div className="mb-6 flex items-start justify-between gap-4">
                        <div
                          className="flex h-11 w-11 items-center justify-center rounded-xl border"
                          style={{ borderColor: config.accentBorder, background: config.accentDim }}
                        >
                          <Icon className="h-5 w-5" style={{ color: config.accent }} />
                        </div>

                        <div className="flex items-center gap-2">
                          {isComingSoon && (
                            <span className="rounded-full border border-white/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                              Coming soon
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Label */}
                      <p className={`mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] ${config.accentText}`}>
                        {config.label}
                      </p>

                      {/* Headline */}
                      <h2 className="font-display text-3xl leading-none text-foreground md:text-4xl mb-3">
                        {config.headline}
                      </h2>

                      {/* Pitch */}
                      <p className="text-sm leading-relaxed text-muted-foreground mb-6 max-w-sm">
                        {config.pitch}
                      </p>

                      {/* Industry examples */}
                      <div className="mb-7 flex flex-wrap gap-1.5">
                        {category.examples.map((example) => (
                          <span
                            key={example}
                            className="rounded-full border border-white/8 bg-white/[0.03] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground"
                          >
                            {example}
                          </span>
                        ))}
                      </div>

                      {/* CTA */}
                      <div className={`mt-auto flex items-center gap-2 text-sm font-semibold transition-all duration-200 group-hover:gap-3 ${config.accentText}`}>
                        {isComingSoon ? "Preview direction" : "Explore solutions"}
                        <ArrowRight className="h-4 w-4" />
                      </div>
                    </div>
                  </Link>
                </Reveal>
              );
            })}
          </div>

          {/* Bottom note */}
          <Reveal delay={400}>
            <p className="mt-10 text-center text-sm text-muted-foreground">
              Not sure which fits?{" "}
              <a href="mailto:hello@kasitek.co.za" className="font-semibold text-[#E8A020] hover:text-[#d4920d] transition-colors">
                Talk to the team
              </a>{" "}
              and we&apos;ll match you to the right path.
            </p>
          </Reveal>
        </div>
      </section>

      <Footer />
    </main>
  );
}
