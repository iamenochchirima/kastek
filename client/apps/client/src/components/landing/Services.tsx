"use client";

import { motion } from "framer-motion";
import { Layers, ShieldCheck, SlidersHorizontal } from "lucide-react";

const reasons = [
  {
    icon: SlidersHorizontal,
    title: "Built Around Your Process",
    description:
      "Not a generic template. Booking flows, quotation logic, and automations are shaped around how your business actually runs — not the other way around.",
    tone: "primary" as const,
  },
  {
    icon: ShieldCheck,
    title: "Deliver It Under Your Brand",
    description:
      "Agencies and consultants can package and offer AI services to their clients, fully branded. You own the client relationship — we handle the infrastructure.",
    tone: "primary" as const,
  },
  {
    icon: Layers,
    title: "Built to Scale Across Clients and Locations",
    description:
      "For software vendors, franchises, and multi-location businesses that need one AI system running consistently everywhere — with central visibility and control.",
    tone: "accent" as const,
  },
];

const toneClasses = {
  primary: {
    icon: "border-primary/20 bg-primary/10 text-primary",
    line: "bg-primary",
  },
  accent: {
    icon: "border-accent/20 bg-accent/10 text-accent",
    line: "bg-accent",
  },
};

export function Services() {
  return (
    <section
      className="border-y border-border bg-card px-6 py-20 md:px-12 md:py-32"
      id="why"
    >
      <div className="mx-auto max-w-7xl">
        <div className="mb-14 grid grid-cols-1 gap-8 md:mb-20 md:grid-cols-2 md:items-end">
          <div>
            <h2 className="font-display text-4xl leading-none sm:text-5xl md:text-6xl">
              Why KasiTek?
            </h2>
          </div>
          <p className="text-base leading-relaxed text-muted-foreground md:max-w-md">
            Whether you run a business, deliver for clients, or build on top of
            our platform — KasiTek is designed to work the way you actually
            operate.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {reasons.map((reason, index) => {
            const tone = toneClasses[reason.tone];
            const Icon = reason.icon;
            return (
              <motion.div
                key={reason.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-80px" }}
                transition={{ duration: 0.45, delay: index * 0.07 }}
                className={[
                  "group relative overflow-hidden rounded-2xl border border-white/8 bg-[#0D0D0D] p-7 text-center transition-colors duration-300 hover:border-primary/20 hover:bg-black md:p-9",
                  index === reasons.length - 1 && reasons.length % 2 === 1
                    ? "sm:col-span-2 sm:mx-auto sm:w-[calc(50%-0.5rem)]"
                    : "",
                ].join(" ")}
              >
                <div
                  className={`absolute left-0 top-0 h-[2px] w-full origin-left scale-x-0 transition-transform duration-500 ease-out group-hover:scale-x-100 ${tone.line}`}
                />

                <div
                  className={`mb-6 inline-flex h-12 w-12 items-center justify-center rounded-xl border ${tone.icon}`}
                >
                  <Icon className="h-5 w-5" />
                </div>

                <h3 className="mb-3 font-display text-2xl leading-snug text-foreground md:text-3xl">
                  {reason.title}
                </h3>

                <p className="mx-auto max-w-[34ch] text-sm leading-relaxed text-muted-foreground">
                  {reason.description}
                </p>
              </motion.div>
            );
          })}
        </div>

        {/* Stats bar */}
        <div className="mt-12 grid grid-cols-2 gap-[1px] overflow-hidden rounded-xl bg-border md:mt-16 lg:grid-cols-4">
          {[
            { label: "Hours saved weekly", val: "40+" },
            { label: "Faster response time", val: "10x" },
            { label: "Automations running", val: "24/7" },
            { label: "Uptime guarantee", val: "99%" },
          ].map((stat, i) => (
            <div
              key={i}
              className="group flex flex-col items-center justify-center bg-[#0D0D0D] p-6 text-center transition-colors hover:bg-black sm:p-8 md:p-10"
            >
              <span className="mb-2 font-display text-4xl text-primary transition-transform duration-300 group-hover:scale-110 sm:text-5xl md:text-6xl">
                {stat.val}
              </span>
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {stat.label}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
