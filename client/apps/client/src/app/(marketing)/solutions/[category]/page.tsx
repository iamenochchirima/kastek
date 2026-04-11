import Link from "next/link";
import { notFound } from "next/navigation";
import { Footer } from "@/components/landing/Footer";
import { Navbar } from "@/components/landing/Navbar";
import { SolutionsMenu } from "@/components/landing/solutions-menu";
import { solutionCategoryMap } from "../data";

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

  return (
    <main className="relative min-h-screen w-full selection:bg-primary/30 selection:text-primary">
      <div className="bg-noise" />
      <Navbar />

      <section className="px-6 pb-16 pt-32 md:px-12 md:pt-40">
        <div className="mx-auto max-w-7xl">
          <div className="mb-10 flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
            <div className="max-w-3xl">
              <Link
                href="/solutions"
                className="mb-5 inline-flex items-center text-sm font-semibold text-primary transition hover:text-primary/80"
              >
                &larr; All Solutions
              </Link>
              <h1 className="font-display text-5xl leading-none sm:text-6xl md:text-8xl">
                {solution.title}
              </h1>
              <p className="mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground md:text-lg">
                {solution.intro}
              </p>
            </div>

            <div className="md:pt-4">
              <SolutionsMenu currentSlug={solution.slug} />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div className="rounded-2xl border border-white/8 bg-[#0D0D0D] p-7 md:p-9">
              <p className="mb-3 text-sm font-semibold uppercase tracking-[0.22em] text-primary">
                {solution.primarySectionTitle}
              </p>
              <h2 className="font-display text-3xl leading-none text-foreground md:text-4xl">
                {solution.shortTitle}
              </h2>
              <p className="mt-4 text-sm leading-relaxed text-muted-foreground md:text-base">
                {solution.primarySectionDescription}
              </p>

              <ul className="mt-8 space-y-3">
                {solution.primaryItems.map((item) => (
                  <li
                    key={item}
                    className="rounded-xl border border-white/8 bg-white/[0.03] px-4 py-3 text-sm leading-relaxed text-foreground/90"
                  >
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-2xl border border-white/8 bg-[#0D0D0D] p-7 md:p-9">
              <p className="mb-3 text-sm font-semibold uppercase tracking-[0.22em] text-primary">
                {solution.secondarySectionTitle}
              </p>
              <h2 className="font-display text-3xl leading-none text-foreground md:text-4xl">
                Tailored for your model
              </h2>
              <p className="mt-4 text-sm leading-relaxed text-muted-foreground md:text-base">
                {solution.secondarySectionDescription}
              </p>

              <ul className="mt-8 space-y-3">
                {solution.secondaryItems.map((item) => (
                  <li
                    key={item}
                    className="rounded-xl border border-white/8 bg-white/[0.03] px-4 py-3 text-sm leading-relaxed text-foreground/90"
                  >
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="mt-10 flex flex-col gap-4 sm:flex-row">
            <Link
              href="/get-quote"
              className="inline-flex items-center justify-center rounded-lg border border-primary/20 bg-primary/10 px-6 py-3 font-semibold text-primary transition-colors hover:bg-primary hover:text-primary-foreground"
            >
              Talk to KasiTek
            </Link>
            <Link
              href="/pricing"
              className="inline-flex items-center justify-center rounded-lg border border-border px-6 py-3 font-semibold text-foreground transition-colors hover:bg-white/5"
            >
              View Pricing
            </Link>
          </div>
        </div>
      </section>

      <Footer />
    </main>
  );
}
