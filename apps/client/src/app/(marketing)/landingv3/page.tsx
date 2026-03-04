import Link from "next/link";
import Footer from "@/components/Footer";
import SequentialHeroLines from "@/components/sequential-hero-lines";

const packages = [
  {
    name: "Web Presence",
    text: "For businesses that need a sharper online presence and a cleaner lead path.",
    items: ["Business website", "Landing pages", "Redesigns", "Conversion-focused structure"],
  },
  {
    name: "AI Agents",
    text: "For businesses ready to automate customer conversations and follow-up.",
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
    text: "For businesses that want multi-channel automation and a broader growth system.",
    items: [
      "Lead capture",
      "Follow-up automation",
      "WhatsApp marketing",
      "Outreach systems",
    ],
  },
];

function Nav() {
  return (
    <nav className="sticky top-0 z-50 border-b border-border bg-bg/82 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4 md:px-10">
        <Link href="/" className="flex items-center gap-2 no-underline">
          <img src="/logo.png" alt="KasiAI" className="h-8 w-8" />
          <span className="text-2xl font-semibold tracking-tight text-text">
            Kasi<span className="text-accent">AI</span>
          </span>
        </Link>

        <div className="hidden items-center gap-6 lg:flex">
          <a href="#packages" className="text-sm text-text-muted transition hover:text-text">
            Packages
          </a>
          <a href="#packages" className="text-sm text-text-muted transition hover:text-text">
            Services
          </a>
        </div>

        <div className="flex items-center gap-3">
          <Link href="/pricing" className="text-sm text-text-muted transition hover:text-text">
            Pricing
          </Link>
          <Link
            href="/get-quote"
            className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-bg transition hover:-translate-y-0.5"
          >
            Get a Quote
          </Link>
        </div>
      </div>
    </nav>
  );
}

export default function LandingV3Page() {
  return (
    <div className="min-h-screen bg-bg text-text">
      <Nav />

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
                KasiAI helps businesses look better online, respond faster to customers, and grow
                with connected systems across websites, AI agents, messaging, follow-up, and
                campaigns.
              </p>

              <div className="mt-10 flex flex-wrap justify-center gap-4">
                <Link
                  href="/get-quote"
                  className="rounded-full bg-accent px-7 py-3 text-sm font-bold uppercase tracking-[0.12em] text-bg transition hover:-translate-y-0.5"
                >
                  Start With KasiAI
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
              The offer should be easy to buy into at the beginning, but clearly structured so a
              client can grow into a larger system.
            </p>
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            {packages.map((pkg) => (
              <div
                key={pkg.name}
                className={`rounded-[2rem] border p-8 ${
                  pkg.featured
                    ? "border-accent/50 bg-accent/10"
                    : "border-border bg-surface"
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
              </div>
            ))}
          </div>
        </section>

      </main>

      <Footer />
    </div>
  );
}
