import Link from "next/link";
import Footer from "@/components/Footer";
import SequentialHeroLines from "@/components/sequential-hero-lines";
import Navbar from "@/components/Navbar";

const packages = [
  {
    name: "AI Agents",
    text: "Automate customer chats, qualification, and handover with less manual effort.",
    items: [
      "Website assistant",
      "WhatsApp agent",
      "Facebook messaging agent",
      "Voice agent",
    ],
    featured: true,
  },
  {
    name: "Growth Systems",
    text: "Scale follow-up and campaigns across channels with repeatable systems.",
    items: [
      "Lead capture",
      "Follow-up automation",
      "WhatsApp marketing",
      "Outreach systems",
    ],
  },
];

export default async function HomePage() {
  return (
    <div className="min-h-screen bg-bg text-text">
      <Navbar />

      <main>
        <section className="relative overflow-hidden">
          <div className="absolute inset-0" style={{ backgroundImage: "var(--theme-hero-aura)" }} />
          <div className="absolute left-8 top-24 h-56 w-56 rounded-full border border-border" />
          <div className="absolute right-[-80px] top-28 h-72 w-72 rounded-full bg-accent/10 blur-3xl" />

          <div className="relative mx-auto max-w-7xl px-6 pb-28 pt-20 md:px-10 md:pb-32 md:pt-24">
            <div className="mx-auto flex max-w-5xl flex-col items-center text-center">
              <div className="flex flex-wrap justify-center gap-3">
                {["Presence", "Conversations", "Growth"].map((item) => (
                  <div
                    key={item}
                    className="rounded-full border border-border bg-surface/70 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-text-muted"
                  >
                    {item}
                  </div>
                ))}
              </div>

              <SequentialHeroLines />

              <p className="mt-7 max-w-3xl text-lg leading-8 text-text-muted">
                KasiTek helps businesses respond faster, capture better leads, and grow with AI
                agents, messaging automation, follow-up systems, and campaigns. When needed, we
                also build the digital infrastructure that supports those systems.
              </p>

              <div className="mt-10 flex flex-wrap justify-center gap-4">
                <Link
                  href="/get-quote"
                  className="rounded-full bg-accent px-7 py-3 text-sm font-bold uppercase tracking-[0.12em] text-bg transition hover:-translate-y-0.5"
                >
                  Start With KasiTek
                </Link>
                <a
                  href="#packages"
                  className="rounded-full border border-border px-7 py-3 text-sm font-bold uppercase tracking-[0.12em] text-text transition hover:border-accent/50 hover:text-accent"
                >
                  Explore Services
                </a>
              </div>
            </div>
          </div>
        </section>

        <section id="packages" className="mx-auto max-w-7xl px-6 py-20 md:px-10">
          <div className="mb-10 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <h2 className="max-w-2xl text-4xl font-black uppercase leading-[0.95] tracking-[-0.04em]">
              Start with the layer your business needs most, then expand.
            </h2>
            <p className="max-w-xl text-sm leading-7 text-text-muted">
              Launch with the system that solves the biggest bottleneck first, then expand into a
              more connected growth setup over time.
            </p>
          </div>

          <div className="mx-auto grid max-w-5xl gap-5 lg:grid-cols-2">
            {packages.map((pkg) => (
              <div
                key={pkg.name}
                className={`flex h-full flex-col rounded-[2rem] border p-8 ${
                  pkg.featured ? "border-accent/50 bg-accent/10" : "border-border bg-surface"
                }`}
              >
                <h3 className="text-2xl font-black uppercase">{pkg.name}</h3>
                <p className="mt-5 text-base leading-8 text-text-muted">{pkg.text}</p>
                <div className="my-8 h-px bg-border" />
                <div className="space-y-4">
                  {pkg.items.map((item) => (
                    <div key={item} className="text-sm leading-7 text-text">
                      {item}
                    </div>
                  ))}
                </div>
                <div className="mt-8" />
              </div>
            ))}
          </div>

          <div className="mx-auto mt-6 max-w-5xl rounded-[2rem] border border-border bg-surface px-8 py-6">
            <p className="max-w-4xl text-sm leading-7 text-text-muted">
              Supporting infrastructure is available where needed, including websites, landing
              pages, dashboards, and custom web tools that help these systems perform better.
            </p>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
