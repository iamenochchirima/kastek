"use client";

import Link from "next/link";
import { motion } from "framer-motion";

const services = [
  {
    num: "01",
    title: "Custom AI Agents",
    desc: "Fully custom agents built around your specific business — menus, booking logic, multilingual flows, complex handoffs.",
    tags: ["WhatsApp", "Website", "Facebook", "Instagram", "Multi-language"]
  },
  {
    num: "02",
    title: "Voice Agents",
    desc: "AI phone agents that answer calls, handle FAQs, book appointments, and escalate. Built on your business's real call scripts.",
    tags: ["Local phone numbers", "Custom scripts", "Call routing", "Booking logic"]
  },
  {
    num: "03",
    title: "Growth Workflows",
    desc: "End-to-end automation: lead capture → qualification → follow-up → conversion. Built to run reliably in the background without you.",
    tags: ["Lead follow-up", "CRM sync", "Multi-channel", "Campaign flows"]
  },
  {
    num: "04",
    title: "System Integrations",
    desc: "Connect your booking system, POS, or spreadsheet to your agent and workflows. Your tools talk to each other.",
    tags: ["POS connect", "Calendar sync", "Google Sheets", "Custom APIs"]
  },
  {
    num: "05",
    title: "Digital Infrastructure",
    desc: "Websites, landing pages, web apps, and dashboards that support your agents and workflows and convert better.",
    tags: ["Landing pages", "Web apps", "Dashboards", "Custom tools"]
  },
  {
    num: "06",
    title: "Managed Retainers",
    desc: "We don't just build and leave. Monthly retainers where we manage, optimise, and expand your systems as you grow.",
    tags: ["Monthly management", "Reporting", "Ongoing optimisation"]
  }
];

export function Services() {
  return (
    <section className="border-y border-border bg-card px-6 py-20 md:px-12 md:py-32" id="services">
      <div className="max-w-7xl mx-auto">
        <div className="mb-14 grid grid-cols-1 gap-8 md:mb-24 md:grid-cols-2 md:gap-12 md:items-end">
          <div>
            <p className="text-sm font-semibold tracking-wider text-primary uppercase mb-4">Services</p>
            <h2 className="font-display text-4xl leading-none sm:text-5xl md:text-7xl">We build it<br/>for you</h2>
          </div>
          <p className="text-muted-foreground md:max-w-md text-base leading-relaxed">
            When your setup is too specific for a self-serve product, we build it custom. Scoped, built, and delivered — with optional ongoing management.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-[1px] bg-border rounded-xl overflow-hidden">
          {services.map((svc, i) => (
            <motion.div
              key={svc.num}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1, duration: 0.5 }}
              className="group relative flex flex-col overflow-hidden bg-[#0D0D0D] p-6 transition-colors duration-300 hover:bg-black sm:p-8 md:p-10"
            >
              {/* Hover Top Border */}
              <div className="absolute top-0 left-0 w-full h-[2px] bg-primary origin-left scale-x-0 group-hover:scale-x-100 transition-transform duration-500 ease-out z-20" />
              
              <div className="font-display text-6xl text-white/5 mb-6 leading-none transition-colors group-hover:text-primary/10">
                {svc.num}
              </div>
              
              <h3 className="font-sans text-xl font-semibold text-foreground mb-3 relative z-10">
                {svc.title}
              </h3>
              
              <p className="text-muted-foreground text-sm leading-relaxed mb-8 flex-grow relative z-10">
                {svc.desc}
              </p>
              
              <div className="flex flex-wrap gap-2 relative z-10">
                {svc.tags.map(tag => (
                  <span key={tag} className="text-[11px] font-medium text-muted-foreground bg-white/5 border border-white/10 px-2.5 py-1 rounded transition-colors group-hover:border-white/20 group-hover:text-white/80">
                    {tag}
                  </span>
                ))}
              </div>

              <div className="relative z-10 mt-8">
                <Link
                  href={`/get-quote?service=${encodeURIComponent(svc.title)}`}
                  className="inline-flex items-center rounded-lg border border-primary/15 bg-white/[0.03] px-4 py-2.5 text-sm font-semibold text-white/58 transition-colors hover:border-primary/30 hover:bg-primary/10 hover:text-primary"
                >
                  Get Quote
                </Link>
              </div>
            </motion.div>
          ))}
        </div>
        
        {/* Stats Bar */}
        <div className="mt-16 grid grid-cols-2 gap-[1px] overflow-hidden rounded-xl bg-border md:mt-24 lg:grid-cols-4">
          {[
            { label: "Hours saved weekly", val: "40+" },
            { label: "Faster response time", val: "10x" },
            { label: "Automations running", val: "24/7" },
            { label: "Uptime guarantee", val: "99%" },
          ].map((stat, i) => (
            <div key={i} className="group flex flex-col items-center justify-center bg-[#0D0D0D] p-6 text-center transition-colors hover:bg-black sm:p-8 md:p-10">
              <span className="mb-2 font-display text-4xl text-primary transition-transform duration-300 group-hover:scale-110 sm:text-5xl md:text-6xl">{stat.val}</span>
              <span className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">{stat.label}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
