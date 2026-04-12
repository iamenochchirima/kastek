import Link from "next/link";
import { Footer } from "@/components/landing/Footer";
import { Navbar } from "@/components/landing/Navbar";
import { SolutionsMenu } from "@/components/landing/solutions-menu";
import { solutionCategories } from "./data";

export default function SolutionsPage() {
  return (
    <main className="relative min-h-screen w-full selection:bg-primary/30 selection:text-primary">
      <div className="bg-noise" />
      <Navbar />

      <section className="px-6 pb-14 pt-32 md:px-12 md:pt-40">
        <div className="mx-auto max-w-7xl">
          <div className="mb-10 flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
            <div className="max-w-2xl">
              <p className="mb-4 text-sm font-semibold uppercase tracking-[0.24em] text-primary">
                Solutions
              </p>
              <h1 className="font-display text-4xl leading-none sm:text-5xl md:text-6xl">
                Choose your category.
              </h1>
              <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground md:text-base">
                Browse the category that best fits your business.
              </p>
            </div>

            <div className="md:pt-2">
              <SolutionsMenu />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {solutionCategories.map((category) => {
              const Icon = category.icon;
              return (
                <Link
                  key={category.slug}
                  href={`/solutions/${category.slug}`}
                  className={[
                    "group relative overflow-hidden rounded-2xl border border-white/8 bg-[#0D0D0D] p-5 transition-colors duration-300 hover:border-primary/20 hover:bg-black md:p-6",
                    category.slug === "franchises" ? "lg:col-start-2" : "",
                  ].join(" ")}
                >
                  <div className="absolute inset-x-0 top-0 h-[2px] origin-left scale-x-0 bg-primary transition-transform duration-500 ease-out group-hover:scale-x-100" />

                  <div className="mb-5 flex items-center justify-between gap-3">
                    <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                      <Icon className="h-4 w-4" />
                    </div>
                    {category.readiness === "coming-soon" ? (
                      <span className="rounded-full border border-white/10 px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        Coming soon
                      </span>
                    ) : null}
                  </div>

                  <h2 className="font-display text-2xl leading-none text-foreground md:text-3xl">
                    {category.title}
                  </h2>

                  <p className="mt-3 max-w-[34ch] text-sm leading-relaxed text-muted-foreground">
                    {category.summary}
                  </p>

                  <div className="mt-4 flex flex-wrap gap-2">
                    {category.examples.map((example) => (
                      <span
                        key={example}
                        className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground"
                      >
                        {example}
                      </span>
                    ))}
                  </div>

                  <div className="mt-5 text-sm font-semibold text-primary transition group-hover:text-white">
                    View
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      <Footer />
    </main>
  );
}
