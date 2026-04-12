import Link from "next/link";
import { notFound } from "next/navigation";
import { Footer } from "@/components/landing/Footer";
import { Navbar } from "@/components/landing/Navbar";
import { SolutionServicesShowcase } from "@/components/landing/solution-services-showcase";
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

          <div className="space-y-6">
            <SolutionServicesShowcase
              eyebrow={solution.primarySectionTitle}
              title={solution.shortTitle}
              description={solution.primarySectionDescription}
              services={solution.primaryServices}
            />

            <SolutionServicesShowcase
              eyebrow={solution.secondarySectionTitle}
              title={solution.secondarySectionTitle}
              description={solution.secondarySectionDescription}
              services={solution.secondaryServices}
            />
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
