import type { Metadata } from "next";
import Link from "next/link";
import { Footer } from "@/components/landing/Footer";
import { Navbar } from "@/components/landing/Navbar";

export const metadata: Metadata = {
  title: "About KasiTek",
  description:
    "KasiTek provides business growth solutions including AI products, communication systems, automation, marketing workflows, and service delivery infrastructure.",
};

const services = [
  "AI products, assistants, and workflow tools for sales, support, and operations",
  "WhatsApp, Facebook, Instagram, website, and inbox communication systems",
  "Lead capture, follow-up, booking, quotation, and customer service workflows",
  "Content, campaign, reporting, and business growth support for client teams",
];

export default function AboutPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <Navbar />

      <div className="mx-auto max-w-4xl px-6 pb-24 pt-32 md:px-10 md:pt-36">
        <header className="space-y-5 border-b border-border pb-10">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-primary">
            About
          </p>
          <h1 className="max-w-3xl font-display text-4xl leading-tight text-foreground md:text-6xl">
            KasiTek is the business behind the platform.
          </h1>
          <p className="max-w-3xl text-base leading-8 text-muted-foreground">
            We provide business growth solutions for companies that need better communication,
            stronger follow-up, more consistent operations, and practical AI tools that support
            sales, service delivery, and customer engagement.
          </p>
        </header>

        <div className="space-y-12 py-10">
          <section className="space-y-4">
            <h2 className="text-2xl font-bold text-foreground">What We Do</h2>
            <p className="text-base leading-8 text-muted-foreground">
              KasiTek combines software, automation, AI products, and delivery services to help
              businesses grow and operate more effectively. Our work covers customer communication,
              lead handling, marketing support, workflow automation, reporting, and the systems
              teams need to manage those activities in practice.
            </p>
          </section>

          <section className="space-y-4">
            <h2 className="text-2xl font-bold text-foreground">Services We Provide</h2>
            <ul className="space-y-3 text-base leading-8 text-muted-foreground">
              {services.map((service) => (
                <li key={service}>{service}</li>
              ))}
            </ul>
          </section>

          <section className="space-y-4">
            <h2 className="text-2xl font-bold text-foreground">Who We Serve</h2>
            <p className="text-base leading-8 text-muted-foreground">
              We work with businesses, agencies, consultants, and platform partners that need a
              more structured way to manage growth, customer communication, service workflows, and
              operational delivery.
            </p>
          </section>

          <section className="space-y-4">
            <h2 className="text-2xl font-bold text-foreground">How The Service Is Used</h2>
            <p className="text-base leading-8 text-muted-foreground">
              Clients use KasiTek to manage enquiries, customer conversations, follow-up, bookings,
              quotations, campaigns, publishing, team handoff, and reporting across connected
              channels and internal workflows.
            </p>
          </section>

          <section className="space-y-4 border-t border-border pt-10">
            <h2 className="text-2xl font-bold text-foreground">Business Details</h2>
            <div className="space-y-3 text-base leading-8 text-muted-foreground">
              <p>
                <span className="text-foreground">Business:</span> KasiTek
              </p>
              <p>
                <span className="text-foreground">Region:</span> South Africa
              </p>
              <p>
                <span className="text-foreground">Contact:</span>{" "}
                <a href="mailto:info@kasitek.co.za" className="text-primary hover:underline">
                  info@kasitek.co.za
                </a>
              </p>
            </div>
          </section>

          <section className="space-y-4 border-t border-border pt-10">
            <h2 className="text-2xl font-bold text-foreground">Related Pages</h2>
            <div className="flex flex-col gap-3 text-base">
              <Link href="/meta-business-platform" className="text-primary hover:underline">
                Meta Business Platform
              </Link>
              <Link href="/privacy-policy" className="text-primary hover:underline">
                Privacy Policy
              </Link>
              <Link href="/terms" className="text-primary hover:underline">
                Terms of Service
              </Link>
              <Link href="/data-deletion" className="text-primary hover:underline">
                Data Deletion
              </Link>
            </div>
          </section>
        </div>
      </div>

      <Footer />
    </main>
  );
}
