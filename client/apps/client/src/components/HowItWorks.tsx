const steps = [
  {
    title: "Discovery Call",
    description:
      "A quick 20-minute call to understand your business, your pain points, and where AI can make the biggest impact. No pitch, just listening.",
  },
  {
    title: "Solution Design",
    description:
      "We map out exactly what we'll build, how it integrates with your current tools, and what results to expect. You get a clear proposal within 24 hours.",
  },
  {
    title: "Build & Test",
    description:
      "We build your system and test it thoroughly. You'll see a working demo before anything goes live. Typical build time: 2–4 business days.",
  },
  {
    title: "Launch & Optimise",
    description:
      "We go live and monitor performance closely. We refine the system based on real conversations and data, and provide ongoing support.",
  },
];

export default function HowItWorks() {
  return (
    <section id="process" className="py-24 px-8 max-w-[1100px] mx-auto border-t border-border max-sm:py-16 max-sm:px-6">
      <div className="text-xs uppercase tracking-[0.15em] text-accent mb-4 font-semibold">
        Process
      </div>
      <h2 className="font-serif text-[clamp(2rem,4vw,3rem)] tracking-tight mb-4 font-normal">
        How we work together
      </h2>
      <p className="text-text-muted max-w-[550px] mb-14 text-lg leading-relaxed">
        From first call to live system in under a week. No long
        contracts, no corporate nonsense.
      </p>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-8">
        {steps.map((step, i) => (
          <div key={step.title}>
            <span className="font-serif text-5xl text-border-light leading-none block mb-4">
              {String(i + 1).padStart(2, "0")}
            </span>
            <h4 className="text-base font-semibold mb-2">{step.title}</h4>
            <p className="text-sm text-text-muted leading-relaxed">
              {step.description}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
