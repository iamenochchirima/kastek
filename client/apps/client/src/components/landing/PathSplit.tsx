"use client";

import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";

const audiences = [
  {
    title: "Business Owners",
    description:
      "AI systems to help you respond faster, automate follow-up, and grow.",
    cta: "Explore solutions",
  },
  {
    title: "Agencies & Consultants",
    description:
      "Add AI to your client offering under your brand while we handle the heavy lifting.",
    cta: "Partner with us",
  },
  {
    title: "Software Vendors",
    description:
      "Embed AI workflows and tenant-ready automation into your platform.",
    cta: "See integration models",
  },
  {
    title: "Franchises & Multi-Location",
    description:
      "Run one AI system across every branch with central visibility.",
    cta: "Coming soon",
  },
];

export function PathSplit() {
  return (
    <section className="border-y border-border bg-card/30 px-6 py-20 md:px-12 md:py-24" id="paths">
      <div className="mx-auto max-w-6xl">
        <div className="mx-auto mb-12 max-w-2xl text-center">
          <p className="mb-4 text-sm font-semibold uppercase tracking-[0.24em] text-primary">
            Who It&apos;s For
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {audiences.map((audience, index) => (
            <motion.div
              key={audience.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-100px" }}
              transition={{ duration: 0.45, delay: index * 0.06 }}
              className={[
                "group relative overflow-hidden rounded-2xl border border-white/8 bg-[#0D0D0D] px-6 py-7 text-center transition-colors duration-300 hover:border-primary/20 hover:bg-black md:px-7 md:py-8",
                index === 3 ? "lg:col-start-2" : "",
              ].join(" ")}
            >
              <div className="absolute inset-x-0 top-0 h-[2px] origin-left scale-x-0 bg-primary transition-transform duration-500 ease-out group-hover:scale-x-100" />

              <div className="mx-auto mb-5 h-px w-10 bg-white/10 transition-colors group-hover:bg-primary/30" />

              <h3 className="font-display text-3xl leading-none text-foreground md:text-[2.15rem]">
                {audience.title}
              </h3>

              <p className="mx-auto mt-4 max-w-[26ch] text-sm leading-relaxed text-muted-foreground">
                {audience.description}
              </p>

              <div className="mt-7 inline-flex items-center gap-2 text-sm font-semibold text-primary transition-all duration-300 group-hover:gap-3">
                {audience.cta}
                <ArrowRight className="h-4 w-4" />
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
