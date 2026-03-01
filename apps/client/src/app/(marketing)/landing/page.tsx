import Link from "next/link";
import Footer from "@/components/Footer";

const pillars = [
  {
    title: "Web Presence",
    text: "Business websites and landing pages built to turn traffic into enquiries, bookings, and sales.",
  },
  {
    title: "AI Agents",
    text: "Website, WhatsApp, Facebook, and voice agents that respond faster and guide customers clearly.",
  },
  {
    title: "Growth Systems",
    text: "Follow-up automation, outreach, campaigns, and lead workflows that keep the pipeline moving.",
  },
];

const services = [
  "Business websites",
  "Landing pages",
  "Website AI assistants",
  "WhatsApp AI agents",
  "Facebook messaging agents",
  "Lead capture automation",
  "Follow-up workflows",
  "Campaign systems",
];

const process = [
  {
    step: "01",
    title: "Build",
    text: "Launch or refine the digital presence your business needs to look credible and convert better.",
  },
  {
    step: "02",
    title: "Automate",
    text: "Add AI agents and workflow automation to handle customer conversations and repetitive work.",
  },
  {
    step: "03",
    title: "Grow",
    text: "Run smarter follow-ups, campaigns, and outreach systems that keep bringing business back in.",
  },
];

const packages = [
  {
    name: "Launch",
    summary: "For businesses getting their digital presence in place.",
    items: ["Business website or landing page", "Lead capture setup", "Basic enquiry workflow"],
  },
  {
    name: "Grow",
    summary: "For businesses ready to automate customer engagement.",
    items: ["Website or WhatsApp agent", "Website or landing page", "Follow-up automation"],
  },
  {
    name: "Scale",
    summary: "For businesses that want a complete growth system.",
    items: ["Multi-channel AI agents", "Campaign and outreach systems", "Advanced automation setup"],
  },
];

function Nav() {
  return (
    <nav className="sticky top-0 z-50 border-b border-white/10 bg-[#0b0d0d]/85 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4 md:px-10">
        <Link href="/" className="flex items-center gap-2 no-underline">
          <img src="/logo.png" alt="KasiAI" className="h-8 w-8" />
          <span className="font-serif text-2xl text-white tracking-tight">
            Kasi<span className="text-accent">AI</span>
          </span>
        </Link>

        <div className="hidden items-center gap-6 md:flex">
          <a href="#pillars" className="text-sm text-white/70 transition hover:text-white">
            Focus
          </a>
          <a href="#services" className="text-sm text-white/70 transition hover:text-white">
            Services
          </a>
          <a href="#packages" className="text-sm text-white/70 transition hover:text-white">
            Packages
          </a>
        </div>

        <div className="flex items-center gap-3">
          <Link href="/pricing" className="text-sm text-white/70 transition hover:text-white">
            Pricing
          </Link>
          <Link
            href="/get-quote"
            className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-black transition hover:-translate-y-0.5"
          >
            Get a Quote
          </Link>
        </div>
      </div>
    </nav>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[#0b0d0d] text-white">
      <Nav />

      <main>
        <section className="relative overflow-hidden">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(196,240,77,0.16),transparent_30%),radial-gradient(circle_at_85%_15%,rgba(7,91,82,0.45),transparent_25%)]" />
          <div className="absolute left-10 top-24 h-56 w-56 rounded-full border border-white/10" />
          <div className="absolute right-[-80px] top-32 h-72 w-72 rounded-full bg-accent/10 blur-3xl" />

          <div className="relative mx-auto grid max-w-7xl gap-12 px-6 pb-24 pt-20 md:grid-cols-[1.1fr_0.9fr] md:px-10 md:pb-28 md:pt-24">
            <div>
              <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-accent">
                AI-Powered Business Growth
              </div>

              <h1 className="max-w-4xl text-5xl font-black uppercase leading-[0.94] tracking-[-0.04em] md:text-7xl">
                Build your online presence.
                <br />
                Automate customer conversations.
                <br />
                <span className="text-accent">Grow with smarter systems.</span>
              </h1>

              <p className="mt-6 max-w-2xl text-lg leading-8 text-white/68">
                KasiAI helps businesses launch websites, deploy AI agents, and automate lead
                follow-up, messaging, and growth workflows in one connected system.
              </p>

              <div className="mt-10 flex flex-wrap gap-4">
                <Link
                  href="/get-quote"
                  className="rounded-full bg-accent px-7 py-3 text-sm font-bold uppercase tracking-[0.12em] text-black transition hover:-translate-y-0.5"
                >
                  Start a Project
                </Link>
                <a
                  href="#services"
                  className="rounded-full border border-white/15 px-7 py-3 text-sm font-bold uppercase tracking-[0.12em] text-white transition hover:border-accent/50 hover:text-accent"
                >
                  Explore Services
                </a>
              </div>
            </div>

            <div className="relative">
              <div className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-6 shadow-[0_30px_80px_rgba(0,0,0,0.35)] backdrop-blur-sm">
                <div className="mb-5 flex items-center justify-between border-b border-white/10 pb-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">
                      Growth Stack
                    </p>
                    <h2 className="mt-2 text-2xl font-bold">One system. Multiple levers.</h2>
                  </div>
                  <div className="h-12 w-12 rounded-2xl bg-accent text-center text-3xl font-black leading-[3rem] text-black">
                    K
                  </div>
                </div>

                <div className="grid gap-4">
                  {pillars.map((pillar) => (
                    <div
                      key={pillar.title}
                      className="rounded-[1.5rem] border border-white/10 bg-black/30 p-5"
                    >
                      <div className="mb-3 h-1 w-14 bg-accent" />
                      <h3 className="text-xl font-bold uppercase">{pillar.title}</h3>
                      <p className="mt-3 text-sm leading-7 text-white/65">{pillar.text}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="pillars" className="mx-auto max-w-7xl px-6 py-6 md:px-10 md:py-12">
          <div className="grid gap-5 md:grid-cols-3">
            {pillars.map((pillar) => (
              <div
                key={pillar.title}
                className="rounded-[1.75rem] border border-white/10 bg-[#121515] p-6"
              >
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">
                  {pillar.title}
                </p>
                <p className="mt-4 text-base leading-7 text-white/68">{pillar.text}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="services" className="mx-auto max-w-7xl px-6 py-20 md:px-10">
          <div className="mb-10 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">
                Services
              </p>
              <h2 className="mt-3 text-4xl font-black uppercase tracking-[-0.03em]">
                The pieces that drive growth
              </h2>
            </div>
            <p className="max-w-xl text-sm leading-7 text-white/65">
              Websites, agents, follow-ups, campaigns, and automation all work better when they are
              designed as one system instead of disconnected tools.
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {services.map((service, index) => (
              <div
                key={service}
                className="group rounded-[1.75rem] border border-white/10 bg-[#101212] p-5 transition hover:-translate-y-1 hover:border-accent/30"
              >
                <div className="mb-8 text-sm font-semibold text-accent/80">0{index + 1}</div>
                <h3 className="text-xl font-bold uppercase leading-tight">{service}</h3>
                <div className="mt-8 h-px bg-white/10 transition group-hover:bg-accent/40" />
              </div>
            ))}
          </div>
        </section>

        <section className="border-y border-white/10 bg-[#101414]">
          <div className="mx-auto max-w-7xl px-6 py-20 md:px-10">
            <div className="mb-12 max-w-3xl">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">
                How It Works
              </p>
              <h2 className="mt-3 text-4xl font-black uppercase tracking-[-0.03em]">
                Launch. Automate. Grow.
              </h2>
            </div>

            <div className="grid gap-5 md:grid-cols-3">
              {process.map((item) => (
                <div key={item.step} className="rounded-[1.75rem] bg-black/25 p-6">
                  <p className="text-6xl font-black text-accent/30">{item.step}</p>
                  <h3 className="mt-6 text-2xl font-bold uppercase">{item.title}</h3>
                  <p className="mt-4 text-base leading-7 text-white/65">{item.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="packages" className="mx-auto max-w-7xl px-6 py-20 md:px-10">
          <div className="mb-10">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">
              Packages
            </p>
            <h2 className="mt-3 text-4xl font-black uppercase tracking-[-0.03em]">
              Start where your business is
            </h2>
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            {packages.map((pkg, index) => (
              <div
                key={pkg.name}
                className={`rounded-[2rem] border p-7 ${
                  index === 1
                    ? "border-accent/50 bg-accent/10"
                    : "border-white/10 bg-[#111414]"
                }`}
              >
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">
                  {pkg.name}
                </p>
                <p className="mt-4 text-lg font-medium leading-8 text-white/72">{pkg.summary}</p>
                <div className="my-7 h-px bg-white/10" />
                <div className="space-y-3">
                  {pkg.items.map((item) => (
                    <p key={item} className="text-sm leading-7 text-white/82">
                      {item}
                    </p>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-6 pb-20 md:px-10">
          <div className="rounded-[2rem] border border-accent/30 bg-[linear-gradient(135deg,rgba(196,240,77,0.18),rgba(196,240,77,0.04)_30%,rgba(255,255,255,0.02)_100%)] p-8 md:p-12">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">
              Ready To Grow
            </p>
            <div className="mt-4 flex flex-col gap-8 md:flex-row md:items-end md:justify-between">
              <div className="max-w-3xl">
                <h2 className="text-4xl font-black uppercase tracking-[-0.03em]">
                  Build the website. Add the AI assistant. Automate the follow-up.
                </h2>
                <p className="mt-4 text-base leading-8 text-white/68">
                  KasiAI is positioned to help businesses look better online, respond faster, and
                  grow with connected systems instead of scattered tools.
                </p>
              </div>
              <Link
                href="/get-quote"
                className="rounded-full bg-black px-7 py-3 text-sm font-bold uppercase tracking-[0.12em] text-accent transition hover:-translate-y-0.5"
              >
                Get a Quote
              </Link>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
