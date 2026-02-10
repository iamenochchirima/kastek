export default function Hero() {
  return (
    <div className="flex flex-col justify-center px-8 pt-32 pb-16 max-w-[900px] mx-auto min-h-[85vh] max-sm:px-6 max-sm:pt-28 max-sm:pb-12">
      <div className="inline-flex items-center gap-2 bg-surface border border-border px-4 py-1.5 rounded-full text-sm text-text-muted mb-8 w-fit">
        <span className="w-1.5 h-1.5 bg-accent rounded-full animate-pulse-dot" />
        AI automation for businesses
      </div>

      <h1 className="font-serif text-[clamp(2.8rem,6vw,4.5rem)] leading-[1.1] tracking-tight mb-6 font-normal">
        Your business runs on conversations.
        <br />
        <em className="text-accent">Let AI handle them.</em>
      </h1>

      <p className="text-lg text-text-muted max-w-[560px] leading-relaxed mb-10">
        We build WhatsApp chatbots, AI voice agents, and smart automations that
        handle your customer inquiries, bookings, and admin so you can focus
        on the work that matters.
      </p>

      <div className="flex gap-4 flex-wrap max-sm:flex-col">
        <a
          href="#contact"
          className="bg-accent text-bg px-8 py-3.5 rounded-full font-semibold text-base no-underline inline-flex items-center gap-2 transition-all hover:-translate-y-0.5 hover:shadow-[0_4px_30px_rgba(196,240,77,0.3)] max-sm:text-center max-sm:justify-center"
        >
          Book a Free Discovery Call
        </a>
        <a
          href="#services"
          className="bg-transparent text-text px-8 py-3.5 rounded-full font-medium text-base no-underline border border-border-light transition-all hover:border-text-muted max-sm:text-center max-sm:justify-center"
        >
          See What We Build
        </a>
      </div>
    </div>
  );
}
