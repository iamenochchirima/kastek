"use client";

import { useState, useEffect, useRef } from "react";
import "./brochure-scope.css";
import WhatsAppMockup from "./_components/WhatsAppMockup";
import WebAgentMockup from "./_components/WebAgentMockup";
import AutomationMockup from "./_components/AutomationMockup";
import PartnerMockup from "./_components/PartnerMockup";
import SectionDivider from "./_components/SectionDivider";

const NAV_ITEMS = [
  { label: "WhatsApp AI", href: "#whatsapp" },
  { label: "Web Agent", href: "#web" },
  { label: "Automation", href: "#automation" },
  { label: "Partner Delivery", href: "#partner" },
  { label: "Pricing", href: "#pricing" },
];

function useInView(threshold = 0.15) {
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

function AnimatedSection({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const { ref, inView } = useInView();
  return (
    <div ref={ref} className={`transition-all duration-700 ${inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"} ${className}`}>
      {children}
    </div>
  );
}

const chatMessages = [
  { type: "in" as const, text: "Hi! How can I help you today?", time: "09:01" },
  { type: "out" as const, text: "I need to book an electrical inspection for Friday.", time: "09:02", delay: 800 },
  { type: "in" as const, text: "Sure! I have Friday at 10:00 or 14:00 available. Which works for you?", time: "09:02", delay: 1800 },
  { type: "out" as const, text: "10:00 please. 24 Ntuli Street, Soweto.", time: "09:03", delay: 2800 },
  { type: "in" as const, text: "", time: "09:03", attachment: "booking" as const, delay: 3800 },
];

const quoteMessages = [
  { type: "out" as const, text: "Can you quote me for 8 circuit breakers, 4 distribution boards, and 12m of 2.5mm cable?", time: "10:15", delay: 0 },
  { type: "in" as const, text: "Preparing your quotation now...", time: "10:15", delay: 1000 },
  { type: "in" as const, text: "Your quote is ready:", time: "10:16", attachment: "quote-pdf" as const, delay: 2200 },
];

const catalogueMessages = [
  { type: "out" as const, text: "Do you have Samsung TVs in stock?", time: "11:30", delay: 0 },
  { type: "in" as const, text: "Yes! Here are our current products matching your search:", time: "11:30", attachment: "catalogue" as const, delay: 900 },
  { type: "out" as const, text: "I'll take the 65\" QLED. Can you send me a quote?", time: "11:31", delay: 2200 },
  { type: "in" as const, text: "Done! Quote sent to your email and WhatsApp.", time: "11:31", delay: 3200 },
];

function FeatureRow({
  title,
  description,
  features,
  visual,
  reverse = false,
  accent = "green",
}: {
  title: string;
  description: string;
  features: string[];
  visual: React.ReactNode;
  reverse?: boolean;
  accent?: string;
}) {
  const accentClasses: Record<string, string> = {
    green: "text-green-700 bg-green-50",
    blue: "text-blue-700 bg-blue-50",
    orange: "text-orange-700 bg-orange-50",
    purple: "text-purple-700 bg-purple-50",
  };
  return (
    <AnimatedSection>
      <div className={`grid grid-cols-1 lg:grid-cols-2 gap-12 items-center ${reverse ? "lg:flex-row-reverse" : ""}`}>
        <div className={reverse ? "lg:order-2" : ""}>
          <h3 className="text-2xl font-bold text-gray-900 mb-3">{title}</h3>
          <p className="text-gray-500 leading-relaxed mb-6">{description}</p>
          <ul className="space-y-2.5">
            {features.map((f, i) => (
              <li key={i} className="flex items-start gap-3">
                <span className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center ${accentClasses[accent]}`}>
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                </span>
                <span className="text-gray-700 text-sm leading-relaxed">{f}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className={`flex justify-center ${reverse ? "lg:order-1" : ""}`}>
          {visual}
        </div>
      </div>
    </AnimatedSection>
  );
}

function PricingCard({
  plan,
  price,
  description,
  features,
  highlighted = false,
}: {
  plan: string;
  price: string;
  description: string;
  features: string[];
  highlighted?: boolean;
}) {
  return (
    <div className={`rounded-2xl p-6 flex flex-col gap-5 transition-all duration-200 hover:-translate-y-1 ${highlighted ? "bg-green-700 text-white shadow-xl shadow-green-900/20" : "bg-white border border-gray-200 shadow-md"}`}>
      <div>
        <p className={`text-xs font-bold uppercase tracking-wide mb-1 ${highlighted ? "text-green-200" : "text-green-700"}`}>{plan}</p>
        <p className={`text-3xl font-bold ${highlighted ? "text-white" : "text-gray-900"}`}>{price}</p>
        <p className={`text-sm mt-1 ${highlighted ? "text-green-100" : "text-gray-500"}`}>{description}</p>
      </div>
      <ul className="space-y-2 flex-1">
        {features.map((f, i) => (
          <li key={i} className="flex items-center gap-2 text-sm">
            <span className={`flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center ${highlighted ? "bg-white/20 text-white" : "bg-green-100 text-green-700"}`}>
              <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            </span>
            <span className={highlighted ? "text-green-50" : "text-gray-700"}>{f}</span>
          </li>
        ))}
      </ul>
      <a
        href="mailto:hello@kasitek.co.za"
        className={`w-full text-center py-3 rounded-xl text-sm font-semibold transition-all block ${highlighted ? "bg-white text-green-700 hover:bg-green-50" : "bg-green-700 text-white hover:bg-green-800"}`}
      >
        Get Started
      </a>
    </div>
  );
}

export default function SolutionsV2Page() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 40);
    window.addEventListener("scroll", handler);
    return () => window.removeEventListener("scroll", handler);
  }, []);

  return (
    <div className="brochure-scope min-h-screen bg-white" style={{ scrollBehavior: "smooth" }}>
      {/* Brochure nav */}
      <header className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${scrolled ? "bg-white/95 backdrop-blur-sm shadow-sm" : "bg-transparent"}`}>
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-green-700 flex items-center justify-center">
                <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
                  <path d="M12 0C5.374 0 0 5.373 0 12c0 2.125.549 4.12 1.508 5.854L.057 23.882a.75.75 0 00.918.943l6.163-1.606A11.942 11.942 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.75c-1.963 0-3.786-.558-5.335-1.522l-.38-.227-3.948 1.029 1.076-3.84-.247-.397A9.724 9.724 0 012.25 12c0-5.385 4.365-9.75 9.75-9.75S21.75 6.615 21.75 12 17.385 21.75 12 21.75z"/>
                </svg>
              </div>
              <span className="font-bold text-gray-900 text-lg tracking-tight">KasiTek</span>
            </div>

            <nav className="hidden md:flex items-center gap-6">
              {NAV_ITEMS.map(item => (
                <a key={item.label} href={item.href} className="text-sm text-gray-600 hover:text-green-700 transition-colors font-medium">
                  {item.label}
                </a>
              ))}
            </nav>

            <div className="hidden md:flex items-center gap-3">
              <a href="mailto:hello@kasitek.co.za" className="text-sm text-gray-600 hover:text-green-700 transition-colors font-medium">
                Contact
              </a>
              <a href="mailto:hello@kasitek.co.za?subject=Demo Request" className="bg-green-700 text-white text-sm px-4 py-2 rounded-xl font-semibold hover:bg-green-800 transition-colors shadow-sm">
                Request Demo
              </a>
            </div>

            <button
              className="md:hidden p-2 rounded-lg text-gray-600 hover:bg-gray-100"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={mobileMenuOpen ? "M6 18L18 6M6 6l12 12" : "M4 6h16M4 12h16M4 18h16"} />
              </svg>
            </button>
          </div>
        </div>
        {mobileMenuOpen && (
          <div className="md:hidden bg-white border-t border-gray-100 px-4 py-4 space-y-2 shadow-lg">
            {NAV_ITEMS.map(item => (
              <a key={item.label} href={item.href} onClick={() => setMobileMenuOpen(false)} className="block py-2 text-sm text-gray-600 hover:text-green-700 font-medium">
                {item.label}
              </a>
            ))}
            <a href="mailto:hello@kasitek.co.za?subject=Demo Request" className="block mt-3 bg-green-700 text-white text-sm px-4 py-2.5 rounded-xl font-semibold text-center">
              Request Demo
            </a>
          </div>
        )}
      </header>

      {/* Hero */}
      <section className="relative min-h-screen flex items-center justify-center overflow-hidden" style={{ background: "linear-gradient(135deg, #14532d 0%, #166534 50%, #15803d 100%)" }}>
        <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.25)", backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.06) 1px, transparent 1px)", backgroundSize: "24px 24px" }}></div>
        <div className="relative z-10 max-w-5xl mx-auto px-4 sm:px-6 text-center py-32">
          <div className="inline-flex items-center gap-2 bg-white/10 backdrop-blur-sm px-4 py-1.5 rounded-full mb-8">
            <div className="w-2 h-2 rounded-full bg-green-300 animate-pulse"></div>
            <span className="text-green-100 text-xs font-semibold tracking-wide uppercase">Partner Brochure 2025</span>
          </div>
          <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold text-white mb-6 leading-tight">
            AI systems that help<br />
            <span className="text-green-300">businesses grow smarter</span>
          </h1>
          <p className="text-green-100 text-lg md:text-xl max-w-2xl mx-auto mb-10 leading-relaxed">
            KasiTek helps businesses respond faster, sell more confidently, book more jobs, and automate the work that slows teams down — across WhatsApp, web, bookings, quotations, and partner delivery.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <a href="mailto:hello@kasitek.co.za?subject=Demo Request" className="bg-white text-green-800 px-8 py-3.5 rounded-xl text-sm font-bold hover:bg-green-50 transition-colors shadow-lg">
              Request a Demo
            </a>
            <a href="#whatsapp" className="border border-white/30 text-white px-8 py-3.5 rounded-xl text-sm font-semibold hover:bg-white/10 transition-colors backdrop-blur-sm">
              See How It Works
            </a>
          </div>

          <div className="mt-16 grid grid-cols-2 md:grid-cols-4 gap-4 max-w-3xl mx-auto">
            {[
              { emoji: "💬", label: "WhatsApp AI" },
              { emoji: "🌐", label: "Web Agents" },
              { emoji: "⚡", label: "Automation" },
              { emoji: "🤝", label: "White Label" },
            ].map((item, i) => (
              <div key={i} className="bg-white/10 backdrop-blur-sm rounded-2xl p-4 text-center border border-white/10">
                <div className="text-3xl mb-2">{item.emoji}</div>
                <p className="text-white text-xs font-semibold">{item.label}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 animate-bounce">
          <svg className="w-6 h-6 text-green-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </section>

      {/* Trusted across industries */}
      <section className="py-16 border-y border-gray-100" style={{ background: "#f9fafb" }}>
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <AnimatedSection>
            <div className="text-center mb-10">
              <p className="text-gray-500 text-sm font-medium">Trusted across industries</p>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-center">
              {[
                { emoji: "🏪", label: "Retail Stores" },
                { emoji: "⚡", label: "Electrical Suppliers" },
                { emoji: "🏥", label: "Clinics & Health" },
                { emoji: "🔧", label: "Service Businesses" },
                { emoji: "🏢", label: "Agencies & Vendors" },
              ].map((item, i) => (
                <div key={i} className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 hover:shadow-md transition-shadow">
                  <div className="text-3xl mb-2">{item.emoji}</div>
                  <p className="text-xs font-semibold text-gray-700">{item.label}</p>
                </div>
              ))}
            </div>
          </AnimatedSection>
        </div>
      </section>

      {/* WhatsApp AI */}
      <section id="whatsapp" className="py-24 px-4 sm:px-6 max-w-6xl mx-auto">
        <AnimatedSection>
          <SectionDivider
            id="whatsapp-anchor"
            tag="WhatsApp AI Systems"
            tagColor="bg-green-100 text-green-800"
            title="The conversation that closes the gap"
            description="Your WhatsApp number becomes a 24/7 AI agent — answering questions, taking bookings, showing catalogues, and sending quotations without you lifting a finger."
          />
        </AnimatedSection>

        <div className="space-y-24 mt-16">
          <FeatureRow
            title="Normal chat assistant for quick replies"
            description="The AI handles general questions, product enquiries, business hours, and guided conversations. Customers get instant replies any time of day. The agent can hand off to a human when needed — no dead ends."
            features={[
              "Instant 24/7 responses to common questions",
              "Guided conversation flows for complex enquiries",
              "Smart handoff to a human when required",
              "Handles multiple conversations simultaneously",
              "Learns your business context and tone",
            ]}
            visual={
              <WhatsAppMockup
                messages={[
                  { type: "out", text: "Hi, are you open on Saturdays?", time: "08:45", delay: 0 },
                  { type: "in", text: "Yes! We're open Saturday 8am–1pm. Can I help you with anything else or book an appointment?", time: "08:45", delay: 800 },
                  { type: "out", text: "What services do you offer?", time: "08:46", delay: 1800 },
                  { type: "in", text: "We offer:\n• Electrical installations\n• Circuit inspections\n• DB board upgrades\n• Emergency callouts\n\nWould you like a quote or to book a visit?", time: "08:46", delay: 2800 },
                ]}
                autoAnimate
              />
            }
          />

          <FeatureRow
            title="Booking support for appointments and jobs"
            description="Customers can book directly in WhatsApp — no forms, no phone calls, no back-and-forth. The agent checks availability, confirms the slot, and sends a card with all the details. Reminders go out automatically."
            features={[
              "Natural language booking — no menus to navigate",
              "Confirms appointment and sends a booking card",
              "Integrates with your existing calendar",
              "Automatic reminder messages before appointments",
              "Easy rescheduling and cancellation flows",
            ]}
            visual={
              <WhatsAppMockup
                title="KasiTek Bookings"
                subtitle="Appointment system"
                messages={chatMessages}
                autoAnimate
              />
            }
            reverse
            accent="blue"
          />

          <FeatureRow
            title="Catalogue browsing and product questions"
            description="Customers can browse your product range, ask about availability, compare items, and add products to a quote — all within WhatsApp. No website needed. Perfect for retail stores and distributors."
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
                messages={catalogueMessages}
                autoAnimate
              />
            }
            accent="purple"
          />

          <FeatureRow
            title="Quotation creation with PDF delivery"
            description="Customers describe what they need — the agent turns it into a properly formatted quotation PDF, prices everything, and sends it back by WhatsApp or email within seconds. Ideal for electrical suppliers, hardware stores, and contractors."
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
                messages={quoteMessages}
                autoAnimate
              />
            }
            reverse
            accent="orange"
          />
        </div>
      </section>

      {/* Web Agent */}
      <section id="web" className="py-24" style={{ background: "#f9fafb" }}>
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <AnimatedSection>
            <SectionDivider
              id="web-anchor"
              tag="Web AI Systems"
              tagColor="bg-blue-100 text-blue-800"
              title="The same intelligence, on your website"
              description="Catch visitors while they're already interested. The web agent turns browsers into leads, bookings, and quote requests — without forcing them through long forms."
            />
          </AnimatedSection>

          <div className="space-y-24 mt-16">
            <FeatureRow
              title="Lead capture and smart qualification"
              description="The web agent greets visitors, understands what they're looking for, and collects the right information to qualify them — then routes the lead to the right team member automatically."
              features={[
                "Proactive greeting that feels natural, not robotic",
                "Smart questions to qualify intent and urgency",
                "Captured leads routed to the right person",
                "Works outside business hours to never miss a visitor",
                "Integrates with WhatsApp for follow-up continuation",
              ]}
              visual={<WebAgentMockup scenario="lead" />}
              accent="blue"
            />

            <FeatureRow
              title="Booking requests and appointment scheduling"
              description="Visitors can book directly from your website. No external booking platforms required. The agent shows availability, captures details, and confirms the slot — all in one seamless conversation."
              features={[
                "Integrated calendar availability checking",
                "Instant booking confirmation on screen",
                "Follow-up confirmation sent by email and WhatsApp",
                "Rescheduling and cancellation handled in chat",
                "Works for service calls, consultations, and demos",
              ]}
              visual={<WebAgentMockup scenario="booking" />}
              reverse
              accent="blue"
            />

            <FeatureRow
              title="Quote requests and qualification flows"
              description="Visitors who want a price get it without waiting for a callback. The agent collects requirements, generates a quote, and sends it by email — keeping the visitor engaged rather than sending them to a competitor."
              features={[
                "Quote capture flow tailored to your product range",
                "Instant PDF generation from the conversation",
                "Sent by email immediately — no delays",
                "Sales team receives lead details automatically",
                "Human can step in at any point if needed",
              ]}
              visual={<WebAgentMockup scenario="quote" />}
              accent="blue"
            />
          </div>
        </div>
      </section>

      {/* Automation */}
      <section id="automation" className="py-24 px-4 sm:px-6 max-w-6xl mx-auto">
        <AnimatedSection>
          <SectionDivider
            id="automation-anchor"
            tag="Growth Automation"
            tagColor="bg-purple-100 text-purple-800"
            title="Keep the pipeline moving after the conversation"
            description="Once a lead is captured, KasiTek keeps working behind the scenes — following up, reminding, requesting reviews, and re-engaging leads that went quiet."
          />
        </AnimatedSection>

        <AnimatedSection>
          <div className="mt-16 grid grid-cols-1 lg:grid-cols-2 gap-12 items-start">
            <div>
              <div className="space-y-6">
                {[
                  {
                    icon: "📩",
                    title: "Follow-up sequences that keep leads warm",
                    desc: "Automatically send a warm message 24 hours after first contact, then again at 3 and 7 days if there's no response. Leads don't fall through the cracks.",
                    color: "border-blue-200 bg-blue-50",
                    iconBg: "bg-blue-100",
                  },
                  {
                    icon: "📅",
                    title: "Appointment reminders and confirmations",
                    desc: "Customers get a reminder the day before and 2 hours before their appointment. Reduces no-shows by up to 60% without any manual work.",
                    color: "border-purple-200 bg-purple-50",
                    iconBg: "bg-purple-100",
                  },
                  {
                    icon: "⭐",
                    title: "Review requests and reputation automation",
                    desc: "After a job is marked complete, the agent sends a friendly review request. More reviews, better reputation, more organic leads.",
                    color: "border-yellow-200 bg-yellow-50",
                    iconBg: "bg-yellow-100",
                  },
                  {
                    icon: "📊",
                    title: "Reporting and visibility for teams",
                    desc: "A clear dashboard shows leads captured, messages sent, bookings confirmed, and reviews received. Full visibility without spreadsheets.",
                    color: "border-green-200 bg-green-50",
                    iconBg: "bg-green-100",
                  },
                  {
                    icon: "🔄",
                    title: "Campaign automation for repeat business",
                    desc: "Segment your customers and send targeted campaigns — seasonal offers, service reminders, loyalty messages — automatically, at the right time.",
                    color: "border-orange-200 bg-orange-50",
                    iconBg: "bg-orange-100",
                  },
                ].map((item, i) => (
                  <div key={i} className={`flex gap-4 p-4 rounded-2xl border ${item.color}`}>
                    <div className={`w-10 h-10 rounded-xl ${item.iconBg} flex items-center justify-center text-xl flex-shrink-0`}>
                      {item.icon}
                    </div>
                    <div>
                      <p className="font-semibold text-gray-900 text-sm mb-1">{item.title}</p>
                      <p className="text-gray-500 text-xs leading-relaxed">{item.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="lg:sticky lg:top-24">
              <AutomationMockup />
            </div>
          </div>
        </AnimatedSection>
      </section>

      {/* Partner Delivery */}
      <section id="partner" className="py-24" style={{ background: "linear-gradient(180deg, #f9fafb 0%, #ffffff 100%)" }}>
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <AnimatedSection>
            <SectionDivider
              id="partner-anchor"
              tag="Partner Delivery"
              tagColor="bg-indigo-100 text-indigo-800"
              title="Give your clients a product they can trust"
              description="KasiTek's white-label program lets agencies, consultants, and software vendors offer AI systems under their own brand — while KasiTek handles the infrastructure, setup, and maintenance behind the scenes."
            />
          </AnimatedSection>

          <AnimatedSection>
            <div className="mt-16 grid grid-cols-1 lg:grid-cols-2 gap-12 items-start">
              <div className="lg:sticky lg:top-24">
                <PartnerMockup />
              </div>
              <div className="space-y-6">
                {[
                  {
                    icon: "🏷️",
                    title: "Agencies — White-label under your brand",
                    desc: "Offer a fully branded AI system to your clients. Your logo, your domain, your relationship. KasiTek runs the infrastructure without appearing in the client conversation.",
                    target: "For digital agencies, marketing agencies, and service providers",
                    color: "border-indigo-200 bg-indigo-50",
                    iconBg: "bg-indigo-100",
                  },
                  {
                    icon: "💼",
                    title: "Consultants — Package it as a client-ready service",
                    desc: "Bundle KasiTek into your consulting offering. Deliver AI implementation as a product to your client base — with recurring revenue, not one-off project fees.",
                    target: "For business consultants, tech advisors, and freelancers",
                    color: "border-violet-200 bg-violet-50",
                    iconBg: "bg-violet-100",
                  },
                  {
                    icon: "🔌",
                    title: "Software vendors — Embed into your product",
                    desc: "Add AI chat, booking, quoting, and automation capabilities to your existing software product without building them from scratch. We provide the infrastructure, you own the distribution.",
                    target: "For SaaS companies, POS vendors, and industry software",
                    color: "border-blue-200 bg-blue-50",
                    iconBg: "bg-blue-100",
                  },
                ].map((item, i) => (
                  <div key={i} className={`p-5 rounded-2xl border ${item.color}`}>
                    <div className="flex items-start gap-4">
                      <div className={`w-10 h-10 rounded-xl ${item.iconBg} flex items-center justify-center text-xl flex-shrink-0`}>
                        {item.icon}
                      </div>
                      <div>
                        <p className="font-bold text-gray-900 mb-1">{item.title}</p>
                        <p className="text-gray-600 text-sm leading-relaxed mb-2">{item.desc}</p>
                        <span className="inline-block bg-white/70 text-gray-500 text-[11px] px-2.5 py-1 rounded-full border border-gray-200">
                          {item.target}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}

                <div className="bg-green-700 rounded-2xl p-5 text-white">
                  <p className="font-bold mb-1">What the partnership includes</p>
                  <p className="text-green-100 text-sm mb-4">KasiTek takes care of everything technical, so you can focus on the client relationship.</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {[
                      "AI infrastructure + hosting",
                      "WhatsApp API compliance",
                      "Ongoing model updates",
                      "Client onboarding flows",
                      "Custom domain setup",
                      "Campaign and reporting tools",
                      "Shared or custom domains",
                      "Partner support and training",
                    ].map((item, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm">
                        <svg className="w-3.5 h-3.5 text-green-300 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                        <span className="text-green-50">{item}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </AnimatedSection>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="py-24 px-4 sm:px-6 max-w-6xl mx-auto">
        <AnimatedSection>
          <SectionDivider
            id="pricing-anchor"
            tag="Getting Started"
            tagColor="bg-green-100 text-green-800"
            title="Simple plans, clear value"
            description="Every plan comes with onboarding support and a dedicated setup session. No hidden fees, no long contracts."
          />
        </AnimatedSection>

        <AnimatedSection>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-12">
            <PricingCard
              plan="Starter"
              price="Contact Us"
              description="For small businesses getting started with WhatsApp AI"
              features={[
                "WhatsApp AI chat assistant",
                "Booking and appointment flows",
                "Up to 1,000 conversations/month",
                "Email support",
                "Setup in 5 business days",
              ]}
            />
            <PricingCard
              plan="Growth"
              price="Contact Us"
              description="For businesses ready to automate lead capture and follow-up"
              features={[
                "Everything in Starter",
                "Web agent for your website",
                "Quotation and catalogue flows",
                "Follow-up and reminder automation",
                "Reporting dashboard",
                "Priority support",
              ]}
              highlighted
            />
            <PricingCard
              plan="Partner"
              price="Contact Us"
              description="For agencies and consultants building a client offering"
              features={[
                "Everything in Growth",
                "White-label delivery",
                "Multi-client management",
                "Revenue share model",
                "Shared or custom domains",
                "Partner training and support",
              ]}
            />
          </div>
        </AnimatedSection>
      </section>

      {/* CTA */}
      <section className="py-20 relative overflow-hidden" style={{ background: "linear-gradient(135deg, #14532d 0%, #166534 100%)" }}>
        <div className="absolute inset-0" style={{ backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.08) 1px, transparent 1px)", backgroundSize: "24px 24px" }}></div>
        <div className="relative z-10 max-w-3xl mx-auto px-4 sm:px-6 text-center">
          <AnimatedSection>
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">Ready to see it in action?</h2>
            <p className="text-green-100 text-lg mb-8 leading-relaxed">
              Book a 30-minute demo and we&apos;ll show you exactly how KasiTek would work for your business or your clients.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <a
                href="mailto:hello@kasitek.co.za?subject=Demo Request — Partner Brochure"
                className="bg-white text-green-800 px-8 py-3.5 rounded-xl text-sm font-bold hover:bg-green-50 transition-colors shadow-lg"
              >
                Book a Demo
              </a>
              <a
                href="mailto:hello@kasitek.co.za"
                className="border border-white/30 text-white px-8 py-3.5 rounded-xl text-sm font-semibold hover:bg-white/10 transition-colors"
              >
                Send Us a Message
              </a>
            </div>
          </AnimatedSection>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-gray-900 text-gray-400 py-12 px-4 sm:px-6">
        <div className="max-w-6xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-8">
            <div className="md:col-span-2">
              <div className="flex items-center gap-2.5 mb-3">
                <div className="w-7 h-7 rounded-lg bg-green-700 flex items-center justify-center">
                  <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
                  </svg>
                </div>
                <span className="font-bold text-white text-base">KasiTek</span>
              </div>
              <p className="text-sm leading-relaxed max-w-xs">
                We build AI systems and infrastructure that help businesses grow smarter — across WhatsApp, the web, and partner delivery.
              </p>
            </div>
            <div>
              <p className="text-white text-sm font-semibold mb-3">Solutions</p>
              <ul className="space-y-2 text-sm">
                {["WhatsApp AI", "Web Agent", "Growth Automation", "Partner Delivery"].map(i => (
                  <li key={i}><a href="#whatsapp" className="hover:text-green-400 transition-colors">{i}</a></li>
                ))}
              </ul>
            </div>
            <div>
              <p className="text-white text-sm font-semibold mb-3">Contact</p>
              <ul className="space-y-2 text-sm">
                <li><a href="mailto:hello@kasitek.co.za" className="hover:text-green-400 transition-colors">hello@kasitek.co.za</a></li>
                <li><span>South Africa</span></li>
                <li><a href="mailto:hello@kasitek.co.za?subject=Demo Request" className="hover:text-green-400 transition-colors">Book a Demo</a></li>
              </ul>
            </div>
          </div>
          <div className="border-t border-gray-800 pt-6 flex flex-col sm:flex-row justify-between items-center gap-2">
            <p className="text-xs">© 2025 KasiTek. All rights reserved.</p>
            <p className="text-xs">Partner brochure — for distribution to potential clients</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
