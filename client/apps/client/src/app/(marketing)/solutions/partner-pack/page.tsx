import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { BrochureActions } from "@/components/landing/brochure-actions";
import { Footer } from "@/components/landing/Footer";
import { Navbar } from "@/components/landing/Navbar";

export const metadata = {
  title: "Partner Brochure | KasiTek",
  robots: "noindex",
};

const whatsappFeatures = [
  "Normal chat assistant for quick replies and guided conversations",
  "Booking support for appointments, calls, and service requests",
  "Catalogue browsing for products, offers, and product questions",
  "Quotation creation with PDF delivery by WhatsApp or email",
  "Follow-up and handoff when a human needs to step in",
];

const webFeatures = [
  "Lead capture from the website",
  "Booking requests and enquiries",
  "Quote requests and qualification flows",
  "Live support and smart handoff",
  "A clear route from visitor to customer",
];

const bookingFeatures = [
  "Appointment scheduling",
  "Service requests",
  "Calendar availability",
  "Confirmation and reminders",
  "Rescheduling and cancellations",
];

const quoteFeatures = [
  "Quote capture from chat or web",
  "PDF generation from the request",
  "Send quotes by WhatsApp or email",
  "Quoting flows for stores and service teams",
  "Fast handoff to a human if needed",
];

const automationFeatures = [
  "Follow-up sequences that keep leads warm",
  "Appointment reminders and reactivation flows",
  "Review requests and reputation automation",
  "Reporting and visibility for teams and partners",
  "Campaign automation for repeat business",
];

const partnerFeatures = [
  "Agencies can offer the system under their own brand",
  "Consultants can package it as a client-ready service",
  "Software vendors can embed the capability into their product model",
  "KasiTek handles the infrastructure behind the scenes",
  "Delivery can run on shared or custom domains depending on the model",
];

function FeatureList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-3">
      {items.map((item) => (
        <li key={item} className="flex gap-3 text-sm leading-relaxed text-zinc-300 print:text-zinc-700">
          <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-primary" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-primary">
      {children}
    </p>
  );
}

function MockWindow({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-[30px] border border-white/10 bg-[#121212] p-5 shadow-[0_30px_100px_rgba(0,0,0,0.35)] print:border-zinc-200 print:bg-white print:shadow-none">
      <div className="mb-4 flex items-center justify-between border-b border-white/10 pb-4 print:border-zinc-200">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary">{title}</p>
          <p className="mt-1 text-sm text-zinc-400 print:text-zinc-500">{subtitle}</p>
        </div>
        <div className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-300 print:border-zinc-200 print:bg-zinc-50 print:text-zinc-500">
          Visual
        </div>
      </div>
      <div className="rounded-[24px] border border-white/10 bg-[#090909] p-4 print:border-zinc-200 print:bg-zinc-50">
        {children}
      </div>
    </div>
  );
}

function MessageBubble({
  children,
  tone = "dark",
}: {
  children: ReactNode;
  tone?: "dark" | "accent" | "light";
}) {
  const toneClasses =
    tone === "accent"
      ? "bg-primary text-primary-foreground"
      : tone === "light"
        ? "bg-white text-zinc-950"
        : "bg-white/6 text-white";

  const printToneClasses =
    tone === "accent"
      ? "print:bg-zinc-950 print:text-white"
      : tone === "light"
        ? "print:bg-white print:text-zinc-950"
        : "print:bg-zinc-100 print:text-zinc-900";

  return (
    <div className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${toneClasses} ${printToneClasses}`}>
      {children}
    </div>
  );
}

function WhatsAppMock() {
  return (
    <MockWindow title="WhatsApp assistant" subtitle="Chat, book, quote, and follow up">
      <div className="grid gap-3">
        <div className="flex justify-start">
          <MessageBubble>Hi, how can I help you today?</MessageBubble>
        </div>
        <div className="flex justify-end">
          <MessageBubble tone="accent">I need a quote for electrical equipment.</MessageBubble>
        </div>
        <div className="flex justify-start">
          <MessageBubble>
            I can do that. Share the product list or ask me to create a quote from the details.
          </MessageBubble>
        </div>
        <div className="grid gap-3 pt-2 sm:grid-cols-2">
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-zinc-200 print:border-zinc-200 print:bg-white print:text-zinc-900">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              Booking
            </p>
            <p className="mt-2 text-sm">Appointment confirmed for tomorrow at 10:00.</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-zinc-200 print:border-zinc-200 print:bg-white print:text-zinc-900">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              Quote PDF
            </p>
            <p className="mt-2 text-sm">Quotation sent by WhatsApp and email.</p>
          </div>
        </div>
      </div>
    </MockWindow>
  );
}

function WebMock() {
  return (
    <MockWindow title="Website agent" subtitle="Capture leads before the visitor leaves">
      <div className="grid gap-4 lg:grid-cols-[1fr_0.95fr]">
        <div className="rounded-[24px] border border-white/10 bg-white/[0.04] p-4 text-zinc-200 print:border-zinc-200 print:bg-white print:text-zinc-900">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            Website chat
          </p>
          <p className="mt-2 text-sm leading-6">
            Ask about pricing, bookings, products, services, or support.
          </p>
          <div className="mt-4 space-y-2">
            <MessageBubble tone="light">Need a callback?</MessageBubble>
            <MessageBubble tone="light">Ask for pricing</MessageBubble>
            <MessageBubble tone="light">Book an appointment</MessageBubble>
          </div>
        </div>

        <div className="rounded-[24px] border border-white/10 bg-[#141414] p-4 text-zinc-200 print:border-zinc-200 print:bg-zinc-50 print:text-zinc-900">
          <div className="rounded-2xl border border-primary/20 bg-primary/10 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              Enquiry form
            </p>
            <p className="mt-2 text-sm text-zinc-200 print:text-zinc-700">
              Name, email, service, preferred time, and one click handoff to staff.
            </p>
          </div>
          <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-sm print:border-zinc-200 print:bg-white">
            Lead captured and routed to the right team member.
          </div>
        </div>
      </div>
    </MockWindow>
  );
}

function BookingMock() {
  return (
    <MockWindow title="Booking flow" subtitle="Shown where bookings matter">
      <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="rounded-[24px] border border-white/10 bg-white/[0.04] p-4 text-zinc-200 print:border-zinc-200 print:bg-white print:text-zinc-900">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            Calendar
          </p>
          <div className="mt-4 grid grid-cols-3 gap-2">
            {["09:00", "10:00", "11:30", "13:00", "14:30", "16:00"].map((slot) => (
              <div key={slot} className="rounded-2xl border border-white/10 bg-[#0e0e0e] px-3 py-4 text-center text-sm font-semibold text-white print:border-zinc-200 print:bg-zinc-50 print:text-zinc-900">
                {slot}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-[24px] border border-white/10 bg-white/[0.04] p-4 text-zinc-200 print:border-zinc-200 print:bg-white print:text-zinc-900">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            Confirmation
          </p>
          <p className="mt-2 text-sm leading-6">
            Booking created, customer notified, and a follow-up message queued automatically.
          </p>
          <div className="mt-4 space-y-2">
            <MessageBubble tone="light">Appointment booked for Tuesday at 10:00</MessageBubble>
            <MessageBubble tone="light">Confirmation sent by WhatsApp and email</MessageBubble>
          </div>
        </div>
      </div>
    </MockWindow>
  );
}

function QuoteMock() {
  return (
    <MockWindow title="Quotation flow" subtitle="Quotes with PDF delivery">
      <div className="grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="rounded-[24px] border border-white/10 bg-white/[0.04] p-4 text-zinc-200 print:border-zinc-200 print:bg-white print:text-zinc-900">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            Chat thread
          </p>
          <div className="mt-4 space-y-2">
            <MessageBubble tone="light">Can you quote me for 8 items?</MessageBubble>
            <MessageBubble tone="accent">Yes. I’m preparing the quote now.</MessageBubble>
            <MessageBubble tone="light">Quotation ready. PDF attached.</MessageBubble>
          </div>
        </div>

        <div className="rounded-[24px] border border-white/10 bg-[#f4f4f4] p-4 text-zinc-950 shadow-[0_14px_40px_rgba(0,0,0,0.12)] print:border-zinc-200 print:bg-zinc-50 print:shadow-none">
          <div className="flex items-center justify-between border-b border-zinc-200 pb-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                PDF quote
              </p>
              <p className="mt-1 text-sm text-zinc-600">Electrical equipment quotation</p>
            </div>
            <div className="rounded-full border border-zinc-300 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
              Sent
            </div>
          </div>
          <div className="mt-4 space-y-3">
            <div className="h-3 w-4/5 rounded-full bg-zinc-200" />
            <div className="h-3 w-3/5 rounded-full bg-zinc-200" />
            <div className="h-24 rounded-3xl border border-dashed border-zinc-300 bg-white" />
          </div>
          <p className="mt-4 text-sm text-zinc-600">
            Delivered through WhatsApp or email after the quote is created.
          </p>
        </div>
      </div>
    </MockWindow>
  );
}

function GrowthMock() {
  return (
    <MockWindow title="Growth automation" subtitle="Follow-up, review, and reporting flows">
      <div className="grid gap-4 lg:grid-cols-[1fr_0.9fr]">
        <div className="rounded-[24px] border border-white/10 bg-white/[0.04] p-4 text-zinc-200 print:border-zinc-200 print:bg-white print:text-zinc-900">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            Automation queue
          </p>
          <div className="mt-4 space-y-2">
            <MessageBubble tone="light">Send reminder in 24 hours</MessageBubble>
            <MessageBubble tone="light">Request a review after completion</MessageBubble>
            <MessageBubble tone="light">Re-engage stale lead after 7 days</MessageBubble>
          </div>
        </div>

        <div className="rounded-[24px] border border-white/10 bg-[#141414] p-4 text-zinc-200 print:border-zinc-200 print:bg-zinc-50 print:text-zinc-900">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            Reporting snapshot
          </p>
          <div className="mt-4 space-y-3">
            <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm print:border-zinc-200 print:bg-white">
              <span>Replies captured</span>
              <span className="font-semibold text-primary">84%</span>
            </div>
            <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm print:border-zinc-200 print:bg-white">
              <span>Follow-ups sent</span>
              <span className="font-semibold text-primary">1,200</span>
            </div>
            <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm print:border-zinc-200 print:bg-white">
              <span>Reviews requested</span>
              <span className="font-semibold text-primary">312</span>
            </div>
          </div>
        </div>
      </div>
    </MockWindow>
  );
}

function PartnerMock() {
  return (
    <MockWindow title="Partner delivery" subtitle="For agencies, consultants, and vendors">
      <div className="grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
        <div className="rounded-[24px] border border-white/10 bg-[#141414] p-5 text-zinc-200 print:border-zinc-200 print:bg-white print:text-zinc-900">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            Partner brand
          </p>
          <div className="mt-4 rounded-[24px] border border-primary/20 bg-primary/10 p-5">
            <p className="text-lg font-semibold text-white print:text-zinc-950">Your brand</p>
            <p className="mt-2 text-sm text-zinc-300 print:text-zinc-600">
              KasiTek runs the infrastructure behind the scenes.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          {[
            "Campaign bundles",
            "Client reporting",
            "Add AI to your service offering",
            "Share it with client prospects",
          ].map((item) => (
            <div
              key={item}
              className="rounded-[24px] border border-white/10 bg-white/[0.04] p-4 text-sm text-zinc-200 print:border-zinc-200 print:bg-white print:text-zinc-900"
            >
              {item}
            </div>
          ))}
        </div>
      </div>
    </MockWindow>
  );
}

function Section({
  label,
  title,
  description,
  features,
  visual,
  reverse = false,
}: {
  label: string;
  title: string;
  description: string;
  features: string[];
  visual: ReactNode;
  reverse?: boolean;
}) {
  return (
    <section className="mx-auto max-w-[1200px] px-6 pb-16 md:px-12 print:px-8">
      <div className="grid gap-8 border-t border-white/10 pt-12 lg:items-center print:border-zinc-200 lg:grid-cols-2">
        <div className={reverse ? "lg:order-2" : ""}>
          <SectionLabel>{label}</SectionLabel>
          <h2 className="mt-4 max-w-[12ch] text-3xl font-semibold tracking-tight text-white sm:text-4xl print:text-zinc-950">
            {title}
          </h2>
          <p className="mt-4 max-w-xl text-sm leading-7 text-zinc-300 print:text-zinc-700 sm:text-base">
            {description}
          </p>
          <div className="mt-6">
            <FeatureList items={features} />
          </div>
        </div>

        <div className={reverse ? "lg:order-1" : ""}>{visual}</div>
      </div>
    </section>
  );
}

export default function PartnerPackPage() {
  return (
    <main className="min-h-screen bg-[#070707] text-white print:bg-white print:text-zinc-950">
      <BrochureActions />
      <Navbar />

      <section className="mx-auto max-w-[1200px] px-6 pb-16 pt-28 md:px-12 md:pt-32 print:px-8 print:pt-8">
        <div className="grid gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
          <div className="max-w-2xl">
            <div className="flex items-center gap-4">
              <Image src="/logo.png" alt="KasiTek" width={52} height={52} className="rounded-xl" />
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-primary">
                  Partner brochure
                </p>
                <p className="mt-1 text-sm text-zinc-400 print:text-zinc-500">
                  A clear overview partners can share with clients.
                </p>
              </div>
            </div>

            <h1 className="mt-8 max-w-[13ch] font-display text-5xl leading-[0.94] sm:text-6xl lg:text-7xl">
              We build AI systems and infrastructure that help businesses grow smarter.
            </h1>

            <p className="mt-6 max-w-xl text-base leading-7 text-zinc-300 print:text-zinc-700 sm:text-lg">
              KasiTek helps businesses respond faster, sell more confidently, book more jobs, and
              automate the work that slows teams down across WhatsApp, the web, bookings,
              quotations, follow-up, and partner delivery.
            </p>

            <div className="mt-8 flex flex-wrap gap-3 print:hidden">
              <a
                href="mailto:hello@kasitek.co.za"
                className="rounded-full bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90"
              >
                Request a demo
              </a>
              <Link
                href="/solutions"
                className="rounded-full border border-white/15 bg-white/5 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
              >
                Back to solutions
              </Link>
            </div>

            <div className="mt-10 flex flex-wrap gap-3">
              {["WhatsApp systems", "Web systems", "Growth automation", "Partner delivery"].map(
                (item) => (
                  <span
                    key={item}
                    className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-zinc-200 print:border-zinc-200 print:bg-zinc-50 print:text-zinc-700"
                  >
                    {item}
                  </span>
                )
              )}
            </div>
          </div>

          <div className="relative">
            <div className="absolute -left-4 top-10 h-24 w-24 rounded-full bg-primary/20 blur-2xl" />
            <div className="absolute right-6 top-2 h-28 w-28 rounded-full bg-white/5 blur-3xl" />
            <div className="relative rounded-[36px] border border-white/10 bg-white/[0.03] p-6 shadow-[0_30px_100px_rgba(0,0,0,0.4)] print:border-zinc-200 print:bg-white print:shadow-none">
              <div className="flex items-center justify-between border-b border-white/10 pb-4 print:border-zinc-200">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-primary">
                    Overview
                  </p>
                  <p className="mt-1 text-sm text-zinc-400 print:text-zinc-500">
                    What partners can explain quickly.
                  </p>
                </div>
                <div className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-300 print:border-zinc-200 print:bg-zinc-50 print:text-zinc-500">
                  Printable
                </div>
              </div>

              <div className="mt-6 grid gap-4">
                <div className="rounded-[28px] border border-primary/20 bg-primary/10 p-5">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
                    Core message
                  </p>
                  <p className="mt-2 text-lg font-semibold text-white print:text-zinc-950">
                    Businesses want faster response, smarter follow-up, and fewer missed leads.
                  </p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="rounded-[28px] border border-white/10 bg-[#121212] p-5 print:border-zinc-200 print:bg-zinc-50">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
                      WhatsApp
                    </p>
                    <p className="mt-2 text-sm text-zinc-300 print:text-zinc-700">
                      Chat, bookings, catalogues, quotations, and follow-up.
                    </p>
                  </div>
                  <div className="rounded-[28px] border border-white/10 bg-[#121212] p-5 print:border-zinc-200 print:bg-zinc-50">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
                      Web
                    </p>
                    <p className="mt-2 text-sm text-zinc-300 print:text-zinc-700">
                      Lead capture, booking requests, quote requests, and support.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <Section
        label="WhatsApp AI systems"
        title="Show the customer conversation that closes the gap."
        description="This is the most immediate use case for most businesses. The WhatsApp agent can answer normal chat questions, support bookings, browse catalogues, create quotations, and hand off to a human when required."
        features={whatsappFeatures}
        visual={<WhatsAppMock />}
      />

      <Section
        label="Web AI systems"
        title="Use the same intelligence on the website."
        description="The web agent catches visitors while they are already on the site. It can capture leads, answer enquiries, book appointments, and move a visitor into a useful next step without forcing a long form."
        features={webFeatures}
        visual={<WebMock />}
        reverse
      />

      <Section
        label="Growth automation"
        title="Keep the pipeline moving after the conversation."
        description="Once a lead is captured, KasiTek can keep working behind the scenes. It can follow up, send reminders, ask for reviews, surface reporting, and automate repeat-business campaigns."
        features={automationFeatures}
        visual={<GrowthMock />}
      />

      <Section
        label="Booking systems"
        title="Schedule work and confirm it without friction."
        description="Use automation to handle bookings, appointment availability, and confirmations. It keeps the conversation moving without requiring manual back-and-forth."
        features={bookingFeatures}
        visual={<BookingMock />}
        reverse
      />

      <Section
        label="Quotation systems"
        title="Create and send quotations with less effort."
        description="For stores and service businesses that sell products or jobs with a quote step, KasiTek can turn a conversation into a PDF quotation and send it by WhatsApp or email."
        features={quoteFeatures}
        visual={<QuoteMock />}
      />

      <Section
        label="Partner delivery"
        title="Give agencies, consultants, and vendors a product they can share."
        description="This is the partner side of KasiTek. The system can be shared under the partner’s brand while KasiTek handles the infrastructure, setup, and delivery model in the background."
        features={partnerFeatures}
        visual={<PartnerMock />}
        reverse
      />

      <section className="mx-auto max-w-[1200px] px-6 pb-20 md:px-12 print:px-8 print:pb-10">
        <div className="rounded-[34px] border border-white/10 bg-white/[0.04] px-6 py-10 text-white print:border-zinc-200 print:bg-zinc-50 print:text-zinc-950 sm:px-10 sm:py-12">
          <div className="grid gap-8 lg:grid-cols-[1fr_auto] lg:items-center">
            <div>
              <SectionLabel>Who it fits</SectionLabel>
              <h2 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">
                Retail stores, electrical suppliers, clinics, service businesses, agencies, and
                software vendors.
              </h2>
            </div>
            <Link
              href="/solutions"
              className="rounded-full border border-white/15 bg-white/5 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/10 print:hidden"
            >
              Back to solutions
            </Link>
          </div>
        </div>
      </section>

      <Footer />

      <style>{`
        @page {
          size: A4;
          margin: 16mm;
        }

        @media print {
          body {
            background: white !important;
          }

          nav,
          footer,
          .bg-noise,
          .print\\:hidden {
            display: none !important;
          }

          a {
            color: inherit !important;
            text-decoration: none !important;
          }
        }
      `}</style>
    </main>
  );
}
