import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Footer } from "@/components/landing/Footer";
import { Navbar } from "@/components/landing/Navbar";
import { SolutionServicesShowcase } from "@/components/landing/solution-services-showcase";
import { SolutionsMenu } from "@/components/landing/solutions-menu";
import { CategoryHeroVisual } from "../_components/CategoryHeroVisual";
import { CustomServicesCards } from "../_components/CustomServicesCards";
import { solutionCategoryMap } from "../data";

const ACCENT = {
  smbs: { color: "#3DBA7A", dim: "rgba(61,186,122,0.08)", border: "rgba(61,186,122,0.2)", text: "text-[#3DBA7A]" },
  agencies: { color: "#E8A020", dim: "rgba(232,160,32,0.08)", border: "rgba(232,160,32,0.2)", text: "text-[#E8A020]" },
  "software-vendors": { color: "#60A5FA", dim: "rgba(96,165,250,0.08)", border: "rgba(96,165,250,0.2)", text: "text-[#60A5FA]" },
  franchises: { color: "#A78BFA", dim: "rgba(167,139,250,0.08)", border: "rgba(167,139,250,0.2)", text: "text-[#A78BFA]" },
} as const;

export default async function SolutionCategoryPage({
  params,
}: {
  params: Promise<{ category: string }>;
}) {
  const { category } = await params;
  const solution = solutionCategoryMap[category];

  if (!solution) {
    notFound();
  }

  const accent = ACCENT[category as keyof typeof ACCENT] ?? ACCENT.smbs;

  return (
    <main className="relative min-h-screen w-full bg-background text-foreground">
      <Navbar />

      {/* ── Hero / Header ── */}
      <section className="relative overflow-hidden px-6 pb-20 pt-36 md:px-12 md:pt-44">
        {/* Background glow */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background: `radial-gradient(ellipse at 80% 20%, ${accent.dim} 0%, transparent 55%), radial-gradient(ellipse at 20% 80%, rgba(255,255,255,0.015) 0%, transparent 50%)`,
          }}
        />
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.025]"
          style={{
            backgroundImage: "radial-gradient(circle, #ffffff 1px, transparent 1px)",
            backgroundSize: "28px 28px",
          }}
        />

        <div className="relative z-10 mx-auto max-w-6xl">
          {/* Back + nav row */}
          <div className="mb-10 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <Link
              href="/solutions"
              className="inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground transition hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              All Solutions
            </Link>
            <SolutionsMenu currentSlug={solution.slug} />
          </div>

          {/* Two-column: text left, visual right */}
          <div className="grid grid-cols-1 gap-12 lg:grid-cols-2 lg:items-center xl:gap-20">
            {/* Left: text */}
            <div>
              <span
                className="mb-4 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em]"
                style={{ color: accent.color, borderColor: accent.border, background: accent.dim }}
              >
                <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: accent.color }} />
                {solution.menuLabel}
              </span>

              <h1 className="font-display text-5xl leading-none text-foreground sm:text-6xl md:text-7xl mb-5">
                {solution.title}
              </h1>

              <p className="max-w-lg text-base leading-relaxed text-muted-foreground md:text-lg mb-8">
                {solution.intro}
              </p>

              <div className="flex flex-col gap-3 sm:flex-row">
                <a
                  href="mailto:hello@kasitek.co.za?subject=Demo Request"
                  className="inline-flex items-center justify-center rounded-xl px-6 py-3 text-sm font-bold transition-colors"
                  style={{ background: accent.color, color: accent.color === "#E8A020" ? "#000" : "#fff" }}
                >
                  Request a Demo
                </a>
                <Link
                  href="/pricing"
                  className="inline-flex items-center justify-center rounded-xl border border-border px-6 py-3 text-sm font-semibold text-foreground transition hover:bg-white/5"
                >
                  View Pricing
                </Link>
              </div>
            </div>

            {/* Right: visual */}
            <div className="flex justify-center lg:justify-end">
              <CategoryHeroVisual slug={solution.slug} />
            </div>
          </div>
        </div>
      </section>

      {/* ── Divider ── */}
      <div className="mx-auto max-w-6xl px-6 md:px-12">
        <div className="h-px bg-gradient-to-r from-transparent via-border to-transparent" />
      </div>

      {/* ── Service Showcase ── */}
      <section className="px-6 py-16 md:px-12">
        <div className="mx-auto max-w-6xl space-y-6">
          {/* Section label */}
          <div className="mb-4">
            <span className="text-xs font-semibold uppercase tracking-[0.22em]" style={{ color: accent.color }}>
              {solution.primarySectionTitle}
            </span>
            <p className="mt-1 text-sm text-muted-foreground max-w-lg">{solution.primarySectionDescription}</p>
          </div>

          {solution.primaryServices.some((s) => s.image) ? (
            <CustomServicesCards
              title={solution.primarySectionTitle}
              description={solution.primarySectionDescription}
              services={solution.primaryServices}
              accentColor={accent.color}
              accentBorder={accent.border}
              accentDim={accent.dim}
            />
          ) : (
            <SolutionServicesShowcase
              eyebrow={solution.primarySectionTitle}
              title={solution.shortTitle}
              description={solution.primarySectionDescription}
              services={solution.primaryServices}
            />
          )}

          {solution.secondaryServices.length > 0 && (
            <div className="pt-6">
              <CustomServicesCards
                title={solution.secondarySectionTitle}
                description={solution.secondarySectionDescription}
                services={solution.secondaryServices}
                accentColor={accent.color}
                accentBorder={accent.border}
                accentDim={accent.dim}
              />
            </div>
          )}
        </div>
      </section>

      {/* ── CTA strip ── */}
      <section className="px-6 py-16 md:px-12">
        <div className="mx-auto max-w-6xl">
          <div
            className="rounded-2xl border p-8 md:p-10 flex flex-col md:flex-row md:items-center md:justify-between gap-6"
            style={{ borderColor: accent.border, background: accent.dim }}
          >
            <div>
              <h3 className="font-display text-3xl leading-none text-foreground md:text-4xl mb-2">
                Ready to get started?
              </h3>
              <p className="text-muted-foreground text-sm max-w-md leading-relaxed">
                Book a free 30-minute demo and we&apos;ll walk you through exactly how KasiTek works for {solution.menuLabel.toLowerCase()}.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row flex-shrink-0">
              <a
                href="mailto:hello@kasitek.co.za?subject=Demo Request"
                className="inline-flex items-center justify-center rounded-xl px-6 py-3 text-sm font-bold whitespace-nowrap transition-opacity hover:opacity-90"
                style={{ background: accent.color, color: accent.color === "#E8A020" ? "#000" : "#fff" }}
              >
                Book a Free Demo
              </a>
              <Link
                href="/solutions"
                className="inline-flex items-center justify-center rounded-xl border border-border px-6 py-3 text-sm font-semibold text-foreground transition hover:bg-white/5 whitespace-nowrap"
              >
                ← Other solutions
              </Link>
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </main>
  );
}
