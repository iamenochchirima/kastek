"use client"

import { motion, useInView } from "framer-motion"
import { useRef } from "react"

const services = [
  {
    number: "01",
    title: "Custom AI Agents",
    description: "Fully custom agents built around your specific business — menus, booking logic, multilingual flows, complex handoffs.",
    items: ["WhatsApp", "Website", "Facebook", "Instagram", "Multi-language"]
  },
  {
    number: "02",
    title: "Voice Agents",
    description: "AI phone agents that answer calls, handle FAQs, book appointments, and escalate. Built on your business's real call scripts.",
    items: ["Local phone numbers", "Custom scripts", "Call routing", "Booking logic"]
  },
  {
    number: "03",
    title: "Growth Workflows",
    description: "End-to-end automation: lead capture → qualification → follow-up → conversion. Built in n8n, runs without you.",
    items: ["Lead follow-up", "CRM sync", "Multi-channel", "Campaign flows"]
  },
  {
    number: "04",
    title: "System Integrations",
    description: "Connect your booking system, POS, or spreadsheet to your agent and workflows. Your tools talk to each other.",
    items: ["POS connect", "Calendar sync", "Google Sheets", "Custom APIs"]
  },
  {
    number: "05",
    title: "Digital Infrastructure",
    description: "Websites, landing pages, web apps, and dashboards that support your agents and workflows and convert better.",
    items: ["Landing pages", "Web apps", "Dashboards", "Custom tools"]
  },
  {
    number: "06",
    title: "Managed Retainers",
    description: "We don't just build and leave. Monthly retainers where we manage, optimise, and expand your systems as you grow.",
    items: ["Monthly management", "Reporting", "Ongoing optimisation"]
  }
]

export function Services() {
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: "-100px" })

  return (
    <section id="services" ref={ref} className="bg-card px-6 md:px-12 lg:px-16 py-24 md:py-32">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={isInView ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.6 }}
        className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-20 items-end mb-16"
      >
        <div>
          <span className="text-[10px] font-bold tracking-[0.2em] uppercase text-primary mb-4 block">
            Services
          </span>
          <h2 
            className="text-3xl md:text-4xl lg:text-5xl leading-tight"
            style={{ fontFamily: 'var(--font-serif)' }}
          >
            We build it for you
          </h2>
        </div>
        <p className="text-base text-muted-foreground leading-relaxed max-w-lg">
          When your setup is too specific for a self-serve product, we build it custom. Scoped, built, and delivered — with optional ongoing management.
        </p>
      </motion.div>

      {/* Services Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px bg-border rounded-md overflow-hidden">
        {services.map((service, index) => (
          <motion.div
            key={service.number}
            initial={{ opacity: 0, y: 30 }}
            animate={isInView ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.5, delay: index * 0.1 }}
            className="bg-background p-8 md:p-10 hover:bg-secondary/50 transition-colors"
          >
            <span 
              className="block text-5xl text-foreground/[0.06] leading-none mb-4"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              {service.number}
            </span>
            <h3 className="text-lg font-semibold mb-3 text-foreground">
              {service.title}
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed mb-5">
              {service.description}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {service.items.map((item) => (
                <span 
                  key={item}
                  className="text-[11px] text-muted-foreground bg-foreground/5 border border-border px-2.5 py-1"
                >
                  {item}
                </span>
              ))}
            </div>
          </motion.div>
        ))}
      </div>
    </section>
  )
}
