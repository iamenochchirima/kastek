"use client";

import { useState, useEffect, useRef } from "react";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";
import WhatsAppMockup from "./solutions-v2/_components/WhatsAppMockup";
import WebAgentMockup from "./solutions-v2/_components/WebAgentMockup";
import "./solutions-v2/brochure-scope.css";

function useInView(threshold = 0.12) {
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
      className={`transition-all duration-700 ${inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-10"} ${className}`}
      style={{ transitionDelay: inView ? `${delay}ms` : "0ms" }}
    >
      {children}
    </div>
  );
}

const WHATSAPP_MESSAGES_CHAT = [
  { type: "out" as const, text: "Hi, are you open on Saturdays?", time: "08:45", delay: 0 },
  { type: "in" as const, text: "Yes! We're open Saturday 8am–1pm. Can I help you with anything else or book an appointment?", time: "08:45", delay: 900 },
  { type: "out" as const, text: "What services do you offer?", time: "08:46", delay: 2000 },
  { type: "in" as const, text: "We offer:\n• Electrical installations\n• Circuit inspections\n• DB board upgrades\n• Emergency callouts\n\nWould you like a quote or to book a visit?", time: "08:46", delay: 3200 },
];

const WHATSAPP_MESSAGES_BOOKING = [
  { type: "in" as const, text: "Hi! How can I help you today?", time: "09:01", delay: 0 },
  { type: "out" as const, text: "I need to book an electrical inspection for Friday.", time: "09:02", delay: 900 },
  { type: "in" as const, text: "Sure! I have Friday at 10:00 or 14:00 available. Which works for you?", time: "09:02", delay: 2000 },
  { type: "out" as const, text: "10:00 please. 24 Ntuli Street, Soweto.", time: "09:03", delay: 3100 },
  { type: "in" as const, text: "", time: "09:03", attachment: "booking" as const, delay: 4200 },
];

const WHATSAPP_MESSAGES_CATALOGUE = [
  { type: "out" as const, text: "Do you have Samsung TVs in stock?", time: "11:30", delay: 0 },
  { type: "in" as const, text: "Yes! Here are our current products matching your search:", time: "11:30", attachment: "catalogue" as const, delay: 1000 },
  { type: "out" as const, text: "I'll take the 65\" QLED. Can you send me a quote?", time: "11:31", delay: 2400 },
  { type: "in" as const, text: "Done! Quote sent to your email and WhatsApp.", time: "11:31", delay: 3400 },
];

const WHATSAPP_MESSAGES_QUOTE = [
  { type: "out" as const, text: "Can you quote me for 8 circuit breakers, 4 distribution boards, and 12m of 2.5mm cable?", time: "10:15", delay: 0 },
  { type: "in" as const, text: "Preparing your quotation now...", time: "10:15", delay: 1100 },
  { type: "in" as const, text: "Your quote is ready:", time: "10:16", attachment: "quote-pdf" as const, delay: 2400 },
];

function SectionLabel({ children, color = "gold" }: { children: React.ReactNode; color?: "gold" | "green" | "blue" }) {
  const colorMap = {
    gold: "text-[#E8A020] border-[#E8A020]/30 bg-[#E8A020]/8",
    green: "text-[#3DBA7A] border-[#3DBA7A]/30 bg-[#3DBA7A]/8",
    blue: "text-blue-400 border-blue-400/30 bg-blue-400/8",
  };
  return (
    <span className={`inline-flex items-center gap-2 px-3 py-1 rounded-full border text-[11px] font-semibold tracking-[0.18em] uppercase mb-4 ${colorMap[color]}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${color === "gold" ? "bg-[#E8A020]" : color === "green" ? "bg-[#3DBA7A]" : "bg-blue-400"} animate-pulse`} />
      {children}
    </span>
  );
}

function FeatureRow({
  tag,
  tagColor = "green",
  title,
  description,
  features,
  featureColor = "green",
  visual,
  reverse = false,
}: {
  tag: string;
  tagColor?: "gold" | "green" | "blue";
  title: string;
  description: string;
  features: string[];
  featureColor?: "green" | "gold";
  visual: React.ReactNode;
  reverse?: boolean;
}) {
  const checkColor = featureColor === "green" ? "text-[#3DBA7A] bg-[#3DBA7A]/12 border-[#3DBA7A]/20" : "text-[#E8A020] bg-[#E8A020]/12 border-[#E8A020]/20";

  return (
    <Reveal>
      <div className={`grid grid-cols-1 lg:grid-cols-2 gap-10 xl:gap-16 items-center`}>
        <div className={reverse ? "lg:order-2" : ""}>
          <SectionLabel color={tagColor}>{tag}</SectionLabel>
          <h3 className="font-display text-4xl md:text-5xl text-foreground mb-4 leading-none">{title}</h3>
          <p className="text-muted-foreground text-sm leading-relaxed mb-7 max-w-md">{description}</p>
          <ul className="space-y-3">
            {features.map((f, i) => (
              <li key={i} className="flex items-start gap-3">
                <span className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded-full border flex items-center justify-center ${checkColor}`}>
                  <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                </span>
                <span className="text-foreground/80 text-sm leading-relaxed">{f}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className={`flex justify-center ${reverse ? "lg:order-1" : ""}`}>
          <div className="brochure-scope">{visual}</div>
        </div>
      </div>
    </Reveal>
  );
}

export default function SolutionsPage() {
  return (
    <main className="relative min-h-screen w-full bg-background text-foreground">
      <Navbar />

      {/* ── Hero ── */}
      <section className="relative min-h-screen flex items-center justify-center overflow-hidden pt-24">
        <div
          className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage: "radial-gradient(circle, #E8A020 1px, transparent 1px)",
            backgroundSize: "28px 28px",
          }}
        />
        <div
          className="absolute inset-0 opacity-40"
          style={{
            background:
              "radial-gradient(ellipse at 20% 50%, rgba(61,186,122,0.08) 0%, transparent 50%), radial-gradient(ellipse at 80% 20%, rgba(232,160,32,0.07) 0%, transparent 45%)",
          }}
        />

        <div className="relative z-10 max-w-5xl mx-auto px-6 text-center py-20">
          <Reveal>
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-[#E8A020]/20 bg-[#E8A020]/5 mb-8">
              <span className="w-1.5 h-1.5 rounded-full bg-[#E8A020] animate-pulse" />
              <span className="text-[#E8A020] text-[11px] font-semibold tracking-[0.2em] uppercase">KasiTek Services</span>
            </div>
          </Reveal>

          <Reveal delay={100}>
            <h1 className="font-display text-6xl sm:text-7xl md:text-8xl text-foreground mb-6 leading-none">
              AI that works<br />
              <span className="text-[#E8A020]">while you sleep.</span>
            </h1>
          </Reveal>

          <Reveal delay={200}>
            <p className="text-muted-foreground text-lg md:text-xl max-w-2xl mx-auto mb-10 leading-relaxed">
              WhatsApp AI agents, website chat, booking systems, and quote automation — built for South African businesses that want to respond faster and sell smarter.
            </p>
          </Reveal>

          <Reveal delay={300}>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <a
                href="mailto:hello@kasitek.co.za?subject=Demo Request"
                className="px-8 py-3.5 rounded-xl text-sm font-bold bg-[#E8A020] text-black hover:bg-[#d4920d] transition-colors shadow-lg shadow-[#E8A020]/20"
              >
                Request a Demo
              </a>
              <a
                href="#whatsapp"
                className="px-8 py-3.5 rounded-xl text-sm font-semibold border border-border text-foreground hover:bg-white/5 transition-colors"
              >
                See How It Works ↓
              </a>
            </div>
          </Reveal>

          <Reveal delay={400}>
            <div className="mt-16 grid grid-cols-2 md:grid-cols-4 gap-3 max-w-2xl mx-auto">
              {[
                { icon: "💬", label: "WhatsApp AI" },
                { icon: "🌐", label: "Web Agents" },
                { icon: "⚡", label: "Automation" },
                { icon: "🤝", label: "White Label" },
              ].map((item, i) => (
                <div key={i} className="rounded-2xl p-4 text-center border border-border bg-white/[0.03] hover:bg-white/[0.06] transition-colors">
                  <div className="text-2xl mb-2">{item.icon}</div>
                  <p className="text-foreground text-xs font-semibold">{item.label}</p>
                </div>
              ))}
            </div>
          </Reveal>
        </div>

        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 animate-bounce">
          <svg className="w-5 h-5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </section>

      {/* ── WhatsApp AI ── */}
      <section id="whatsapp" className="py-24 px-6 md:px-12">
        <div className="max-w-6xl mx-auto">
          <Reveal>
            <div className="text-center mb-16">
              <SectionLabel color="green">WhatsApp AI Systems</SectionLabel>
              <h2 className="font-display text-5xl md:text-6xl lg:text-7xl text-foreground mb-5 leading-none">
                The conversation that<br />
                <span className="text-[#3DBA7A]">closes the gap.</span>
              </h2>
              <p className="text-muted-foreground max-w-xl mx-auto text-base leading-relaxed">
                Your WhatsApp number becomes a 24/7 AI agent — answering questions, taking bookings, showing catalogues, and sending quotations without you lifting a finger.
              </p>
            </div>
          </Reveal>

          <div className="space-y-24">
            <FeatureRow
              tag="Chat Assistant"
              tagColor="green"
              featureColor="green"
              title="Instant replies to every customer."
              description="The AI handles general questions, product enquiries, business hours, and guided conversations. Customers get instant replies any time of day, with smart handoff to a human when needed."
              features={[
                "24/7 responses to common questions",
                "Guided conversation flows for complex enquiries",
                "Smart handoff to a human when required",
                "Handles multiple conversations simultaneously",
                "Learns your business context and tone",
              ]}
              visual={
                <WhatsAppMockup
                  messages={WHATSAPP_MESSAGES_CHAT}
                  autoAnimate
                />
              }
            />

            <FeatureRow
              tag="Booking System"
              tagColor="green"
              featureColor="green"
              title="Bookings taken directly in chat."
              description="Customers can book directly in WhatsApp — no forms, no phone calls. The agent checks availability, confirms the slot, and sends a booking card. Reminders go out automatically."
              features={[
                "Natural language booking — no menus to navigate",
                "Confirms appointment and sends a booking card",
                "Integrates with your existing calendar",
                "Automatic reminders before appointments",
                "Easy rescheduling and cancellation flows",
              ]}
              visual={
                <WhatsAppMockup
                  title="KasiTek Bookings"
                  subtitle="Appointment system"
                  messages={WHATSAPP_MESSAGES_BOOKING}
                  autoAnimate
                />
              }
              reverse
            />

            <FeatureRow
              tag="Product Catalogue"
              tagColor="green"
              featureColor="green"
              title="Browse your range, right in WhatsApp."
              description="Customers can browse products, ask about availability, compare items, and add to a quote — all within WhatsApp. No website required. Perfect for retail stores and distributors."
              features={[
                "Display products with images, prices, and stock",
                "Answer product-specific questions in context",
                "Multi-item quote generation from the chat",
                "Filter and search the catalogue with messages",
                "Seasonal and promotional product highlights",
              ]}
              visual={
                <WhatsAppMockup
                  title="KasiTek Shop"
                  subtitle="Product catalogue"
                  messages={WHATSAPP_MESSAGES_CATALOGUE}
                  autoAnimate
                />
              }
            />

            <FeatureRow
              tag="Quotation Engine"
              tagColor="green"
              featureColor="green"
              title="PDF quotes sent in seconds."
              description="Customers describe what they need — the agent turns it into a properly formatted quotation PDF, prices everything, and sends it back by WhatsApp or email instantly. Ideal for electrical suppliers and contractors."
              features={[
                "Convert a chat request into a full PDF quotation",
                "Send the quote by WhatsApp or email instantly",
                "Line-item breakdown with quantities and totals",
                "Customer accepts or requests changes in-chat",
                "Sales team gets notified and can follow up",
              ]}
              visual={
                <WhatsAppMockup
                  title="KasiTek Quotes"
                  subtitle="Quotation system"
                  messages={WHATSAPP_MESSAGES_QUOTE}
                  autoAnimate
                />
              }
              reverse
            />
          </div>
        </div>
      </section>

      {/* ── Divider ── */}
      <div className="max-w-6xl mx-auto px-6 md:px-12">
        <div className="h-px bg-gradient-to-r from-transparent via-border to-transparent" />
      </div>

      {/* ── Web Agent ── */}
      <section id="web" className="py-24 px-6 md:px-12 bg-[#0A0A0A]">
        <div className="max-w-6xl mx-auto">
          <Reveal>
            <div className="text-center mb-16">
              <SectionLabel color="gold">Web AI Systems</SectionLabel>
              <h2 className="font-display text-5xl md:text-6xl lg:text-7xl text-foreground mb-5 leading-none">
                The same intelligence,<br />
                <span className="text-[#E8A020]">on your website.</span>
              </h2>
              <p className="text-muted-foreground max-w-xl mx-auto text-base leading-relaxed">
                Catch visitors while they're already interested. The web agent turns browsers into leads, bookings, and quote requests — without forcing them through long forms.
              </p>
            </div>
          </Reveal>

          <div className="space-y-24">
            <FeatureRow
              tag="Lead Capture"
              tagColor="gold"
              featureColor="gold"
              title="Turn visitors into qualified leads."
              description="The web agent greets visitors, understands what they're looking for, and collects the right information to qualify them — then routes the lead to the right team member automatically."
              features={[
                "Proactive greeting that feels natural, not robotic",
                "Smart questions to qualify intent and urgency",
                "Captured leads routed to the right person",
                "Works outside business hours, never misses a visitor",
                "Integrates with WhatsApp for follow-up continuation",
              ]}
              visual={<WebAgentMockup scenario="lead" />}
            />

            <FeatureRow
              tag="Website Booking"
              tagColor="gold"
              featureColor="gold"
              title="Book from your website, instantly."
              description="Visitors can book directly from your website. No external platforms needed. The agent shows availability, captures details, and confirms the slot — all in one seamless conversation."
              features={[
                "Integrated calendar availability checking",
                "Instant booking confirmation on screen",
                "Follow-up confirmation sent by email and WhatsApp",
                "Rescheduling and cancellation handled in chat",
                "Works for service calls, consultations, and demos",
              ]}
              visual={<WebAgentMockup scenario="booking" />}
              reverse
            />

            <FeatureRow
              tag="Quote Flow"
              tagColor="gold"
              featureColor="gold"
              title="No more waiting for a callback."
              description="Visitors who want a price get it without waiting. The agent collects requirements, generates a quote, and sends it by email — keeping the visitor engaged rather than sending them to a competitor."
              features={[
                "Quote capture flow tailored to your product range",
                "Instant PDF generation from the conversation",
                "Sent by email immediately — no delays",
                "Sales team receives lead details automatically",
                "Human can step in at any point if needed",
              ]}
              visual={<WebAgentMockup scenario="quote" />}
            />
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="py-24 px-6 md:px-12">
        <div className="max-w-3xl mx-auto">
          <Reveal>
            <div className="relative rounded-3xl overflow-hidden border border-border p-12 text-center">
              <div
                className="absolute inset-0 opacity-[0.04]"
                style={{
                  backgroundImage: "radial-gradient(circle, #E8A020 1px, transparent 1px)",
                  backgroundSize: "22px 22px",
                }}
              />
              <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse at 50% 0%, rgba(232,160,32,0.07) 0%, transparent 60%)" }} />
              <div className="relative z-10">
                <SectionLabel color="gold">Get Started</SectionLabel>
                <h2 className="font-display text-5xl md:text-6xl text-foreground mb-4 leading-none">
                  Ready to see it<br />
                  <span className="text-[#E8A020]">in action?</span>
                </h2>
                <p className="text-muted-foreground mb-8 max-w-md mx-auto leading-relaxed">
                  Book a free demo and we'll show you exactly how KasiTek works for your type of business — live, in 30 minutes.
                </p>
                <div className="flex flex-col sm:flex-row gap-3 justify-center">
                  <a
                    href="mailto:hello@kasitek.co.za?subject=Demo Request"
                    className="px-8 py-3.5 rounded-xl text-sm font-bold bg-[#E8A020] text-black hover:bg-[#d4920d] transition-colors shadow-lg shadow-[#E8A020]/20"
                  >
                    Book a Free Demo
                  </a>
                  <a
                    href="mailto:hello@kasitek.co.za"
                    className="px-8 py-3.5 rounded-xl text-sm font-semibold border border-border text-foreground hover:bg-white/5 transition-colors"
                  >
                    Contact Us
                  </a>
                </div>

                <div className="mt-10 grid grid-cols-3 gap-6">
                  {[
                    { value: "24/7", label: "Always on" },
                    { value: "< 5s", label: "Response time" },
                    { value: "0 staff", label: "Required to run" },
                  ].map((s, i) => (
                    <div key={i}>
                      <p className="text-3xl font-bold text-[#E8A020] font-display">{s.value}</p>
                      <p className="text-muted-foreground text-xs mt-1">{s.label}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      <Footer />
    </main>
  );
}
