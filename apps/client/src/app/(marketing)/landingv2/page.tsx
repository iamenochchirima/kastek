import Link from "next/link";
import Footer from "@/components/Footer";

const rails = [
  {
    title: "Presence",
    text: "Websites and landing pages that make the brand feel credible and move visitors toward action.",
  },
  {
    title: "Conversation",
    text: "AI agents across website, WhatsApp, Facebook, and voice that respond instantly and consistently.",
  },
  {
    title: "Momentum",
    text: "Campaigns, outreach, and automation that keep leads warm and drive repeat engagement.",
  },
];

const offerColumns = [
  {
    label: "Web Presence",
    items: ["Business websites", "Landing pages", "Redesigns", "Conversion-focused structure"],
  },
  {
    label: "AI Agents",
    items: ["Website assistant", "WhatsApp agent", "Facebook messaging agent", "Voice agent"],
  },
  {
    label: "Growth Systems",
    items: ["Lead capture", "Follow-up automation", "Campaign workflows", "Outreach systems"],
  },
];

const reasons = [
  "One platform story instead of disconnected services",
  "Built around business growth, not AI hype",
  "Flexible enough for websites, messaging, and automation",
  "Strong fit for local businesses that need practical execution",
];

function Nav() {
  return (
    <nav className="sticky top-0 z-50 border-b border-white/10 bg-[#090a0a]/88 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4 md:px-10">
        <Link href="/" className="flex items-center gap-2 no-underline">
          <img src="/logo.png" alt="KasiAI" className="h-8 w-8" />
          <span className="font-serif text-2xl text-white tracking-tight">
            Kasi<span className="text-accent">AI</span>
          </span>
        </Link>

        <div className="hidden items-center gap-6 md:flex">
          <a href="#model" className="text-sm text-white/70 transition hover:text-white">
            Model
          </a>
          <a href="#offers" className="text-sm text-white/70 transition hover:text-white">
            Offers
          </a>
          <a href="#why" className="text-sm text-white/70 transition hover:text-white">
            Why This Works
          </a>
        </div>

        <Link
          href="/get-quote"
          className="rounded-full border border-accent/35 bg-accent/10 px-5 py-2.5 text-sm font-semibold text-accent transition hover:border-accent/60 hover:bg-accent/15"
        >
          Book a Demo
        </Link>
      </div>
    </nav>
  );
}

export default function LandingV2Page() {
  return (
    <div className="min-h-screen bg-[#090a0a] text-white">
      <Nav />

      <main>
        <section className="relative overflow-hidden border-b border-white/10">
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(196,240,77,0.06),transparent_28%),radial-gradient(circle_at_70%_20%,rgba(196,240,77,0.1),transparent_18%),radial-gradient(circle_at_20%_30%,rgba(22,110,96,0.2),transparent_22%)]" />
          <div className="absolute right-10 top-28 hidden h-40 w-40 rounded-full border border-white/10 lg:block" />

          <div className="relative mx-auto max-w-7xl px-6 pb-24 pt-20 md:px-10 md:pb-28 md:pt-28">
            <div className="max-w-5xl">
              <p className="text-sm font-semibold uppercase tracking-[0.25em] text-accent">
                Digital Presence. AI Agents. Growth Systems.
              </p>
              <h1 className="mt-6 max-w-6xl font-serif text-[3.25rem] leading-[0.95] tracking-[-0.04em] md:text-[5.5rem]">
                KasiAI helps businesses build the front door, automate the conversation, and keep
                growth moving after the first click.
              </h1>
              <p className="mt-8 max-w-3xl text-lg leading-8 text-white/68">
                This direction positions KasiAI as more than a chatbot business. It becomes an
                AI-powered growth partner for businesses that need websites, messaging, follow-up,
                and automation to work together.
              </p>

              <div className="mt-10 flex flex-wrap gap-4">
                <Link
                  href="/get-quote"
                  className="rounded-full bg-accent px-7 py-3 text-sm font-bold uppercase tracking-[0.12em] text-black transition hover:-translate-y-0.5"
                >
                  Start With KasiAI
                </Link>
                <a
                  href="#offers"
                  className="rounded-full border border-white/15 px-7 py-3 text-sm font-bold uppercase tracking-[0.12em] text-white transition hover:border-accent/50 hover:text-accent"
                >
                  View Offer Structure
                </a>
              </div>
            </div>
          </div>
        </section>

        <section id="model" className="mx-auto max-w-7xl px-6 py-18 md:px-10 md:py-20">
          <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="rounded-[2rem] border border-white/10 bg-[#0f1212] p-8">
              <p className="text-sm font-semibold uppercase tracking-[0.25em] text-accent">
                Positioning
              </p>
              <h2 className="mt-4 text-3xl font-black uppercase tracking-[-0.03em]">
                An AI-powered business growth platform
              </h2>
              <p className="mt-5 text-base leading-8 text-white/68">
                The strength of this model is that websites, agents, campaigns, and automation are
                not random add-ons. They are all parts of one business-growth engine.
              </p>
            </div>

            <div className="grid gap-5 md:grid-cols-3">
              {rails.map((rail) => (
                <div key={rail.title} className="rounded-[2rem] bg-[#121616] p-7">
                  <div className="mb-8 h-10 w-10 rounded-full border border-accent/40" />
                  <h3 className="text-2xl font-bold uppercase">{rail.title}</h3>
                  <p className="mt-4 text-sm leading-7 text-white/66">{rail.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="offers" className="bg-[#0f1313] py-20">
          <div className="mx-auto max-w-7xl px-6 md:px-10">
            <div className="mb-12 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.25em] text-accent">
                  Offer Structure
                </p>
                <h2 className="mt-3 text-4xl font-black uppercase tracking-[-0.03em]">
                  Three service lanes. One story.
                </h2>
              </div>
              <p className="max-w-xl text-sm leading-7 text-white/65">
                This keeps the business broad enough to grow, while still staying readable to
                clients who need a simple explanation of what KasiAI actually does.
              </p>
            </div>

            <div className="grid gap-5 lg:grid-cols-3">
              {offerColumns.map((column, index) => (
                <div
                  key={column.label}
                  className={`rounded-[2rem] border p-8 ${
                    index === 1
                      ? "border-accent/45 bg-accent/10"
                      : "border-white/10 bg-[#090b0b]"
                  }`}
                >
                  <p className="text-sm font-semibold uppercase tracking-[0.25em] text-accent">
                    {column.label}
                  </p>
                  <div className="mt-8 space-y-4">
                    {column.items.map((item) => (
                      <div key={item} className="border-b border-white/10 pb-4 text-lg font-medium">
                        {item}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="why" className="mx-auto max-w-7xl px-6 py-20 md:px-10">
          <div className="grid gap-8 lg:grid-cols-[0.85fr_1.15fr]">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.25em] text-accent">
                Why This Direction Works
              </p>
              <h2 className="mt-4 text-4xl font-black uppercase tracking-[-0.03em]">
                It feels bigger than chatbots, but still practical.
              </h2>
            </div>

            <div className="grid gap-4">
              {reasons.map((reason, index) => (
                <div
                  key={reason}
                  className="flex items-start gap-5 rounded-[1.75rem] border border-white/10 bg-[#101313] p-5"
                >
                  <div className="min-w-10 text-3xl font-black text-accent/35">
                    0{index + 1}
                  </div>
                  <p className="pt-1 text-base leading-7 text-white/78">{reason}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-6 pb-20 md:px-10">
          <div className="rounded-[2.25rem] border border-white/10 bg-[linear-gradient(145deg,#101414,#0a0c0c)] p-8 md:p-12">
            <div className="grid gap-6 lg:grid-cols-[1.05fr_0.95fr] lg:items-end">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.25em] text-accent">
                  Final Direction
                </p>
                <h2 className="mt-4 max-w-4xl text-4xl font-black uppercase tracking-[-0.03em]">
                  KasiAI helps businesses build their digital presence, automate customer
                  conversations, and grow with AI-powered systems.
                </h2>
              </div>
              <div className="rounded-[1.75rem] border border-accent/30 bg-accent/10 p-6">
                <p className="text-sm uppercase tracking-[0.2em] text-accent">Best Fit</p>
                <p className="mt-3 text-base leading-8 text-white/75">
                  Use this version if you want the brand to feel more strategic and higher-value,
                  with AI agents positioned as one pillar inside a broader growth system.
                </p>
                <Link
                  href="/get-quote"
                  className="mt-6 inline-flex rounded-full bg-accent px-6 py-3 text-sm font-bold uppercase tracking-[0.12em] text-black transition hover:-translate-y-0.5"
                >
                  Build From This Direction
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
