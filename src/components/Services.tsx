const services = [
  {
    icon: "💬",
    title: "WhatsApp Business Assistants",
    description:
      "An AI assistant on your WhatsApp that answers customer questions, takes bookings, sends quotes, and follows up. 24/7, even when you're closed.",
    tags: [
      "FAQ handling",
      "Appointment booking",
      "Order taking",
      "Lead capture",
      "Status updates",
      "Payment reminders",
    ],
  },
  {
    icon: "📞",
    title: "AI Voice Agents",
    description:
      "Never miss a call again. An AI receptionist that answers your phone, qualifies leads, books appointments, and takes messages in a natural, human-like voice.",
    tags: [
      "Inbound call handling",
      "After-hours reception",
      "Appointment reminders",
      "Payment follow-ups",
    ],
  },
  {
    icon: "🌐",
    title: "Website Chatbots",
    description:
      "A smart chat widget on your website that engages visitors, answers questions instantly, captures leads, and books meetings. Turning browsers into customers.",
    tags: [
      "Live chat widget",
      "Lead qualification",
      "Product/service Q&A",
      "Booking integration",
    ],
  },
  {
    icon: "⚡",
    title: "Business Automations",
    description:
      "Stop doing repetitive admin manually. We connect your tools and automate the workflows that eat your day, from lead capture to invoicing.",
    tags: [
      "CRM integration",
      "Auto-invoicing",
      "Quote generation",
      "Email sequences",
      "Report generation",
    ],
  },
  {
    icon: "🧠",
    title: "Custom AI Agents",
    description:
      "Purpose-built AI agents for your specific operations. From internal knowledge bases your staff can query, to procurement bots that manage your supply chain.",
    tags: [
      "Staff knowledge base",
      "Inventory management",
      "Document processing",
      "Competitor monitoring",
    ],
  },
  {
    icon: "📊",
    title: "AI Strategy & Consulting",
    description:
      "Not sure where to start? We'll audit your operations, identify where AI can save you time and money, and build a practical roadmap. No fluff.",
    tags: [
      "AI readiness audit",
      "Process mapping",
      "Tool selection",
      "Team training",
    ],
  },
  {
    icon: "📈",
    title: "AI-Powered Reporting & Insights",
    description:
      "Turn your business data into clear, actionable dashboards. Track leads, conversions, response times, and revenue, all updated automatically.",
    tags: [
      "Live dashboards",
      "Conversion tracking",
      "Performance reports",
      "Revenue insights",
    ],
  },
];

export default function Services() {
  return (
    <section id="services" className="py-24 px-8 max-w-[1100px] mx-auto max-sm:py-16 max-sm:px-6">
      <div className="text-xs uppercase tracking-[0.15em] text-accent mb-4 font-semibold">
        Services
      </div>
      <h2 className="font-serif text-[clamp(2rem,4vw,3rem)] tracking-tight mb-4 font-normal">
        What we build for businesses
      </h2>
      <p className="text-text-muted max-w-[550px] mb-14 text-lg leading-relaxed">
        Every solution is tailored to your business. No cookie-cutter templates,
        just smart systems that actually work with how you operate.
      </p>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-px bg-border border border-border rounded-2xl overflow-hidden max-sm:grid-cols-1">
        {services.map((service) => (
          <div
            key={service.title}
            className="bg-surface p-9 transition-all duration-400 hover:bg-surface-2"
          >
            <div className="w-11 h-11 rounded-xl flex items-center justify-center mb-5 text-xl bg-accent-glow border border-accent/15">
              {service.icon}
            </div>
            <h3 className="text-lg font-semibold mb-2.5 tracking-tight">
              {service.title}
            </h3>
            <p className="text-text-muted text-sm leading-relaxed">
              {service.description}
            </p>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {service.tags.map((tag) => (
                <span
                  key={tag}
                  className="bg-white/[0.04] border border-border px-3 py-1 rounded-full text-xs text-text-muted"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
