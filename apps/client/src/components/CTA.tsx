export default function CTA() {
  return (
    <section
      id="contact"
      className="py-24 px-8 max-w-[1100px] mx-auto border-t border-border text-center max-sm:py-16 max-sm:px-6"
    >
      <div className="bg-surface border border-border rounded-[20px] py-16 px-8 relative overflow-hidden">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[300px] h-px bg-gradient-to-r from-transparent via-accent to-transparent" />
        <h2 className="font-serif text-[clamp(1.8rem,3.5vw,2.5rem)] mb-4 font-normal">
          Ready to stop losing customers
          <br />
          to slow responses?
        </h2>
        <p className="text-text-muted mb-8 max-w-[450px] mx-auto">
          Book a free 20-minute discovery call. We&apos;ll show you exactly
          where AI can save you time and money. No strings attached.
        </p>
        <div className="flex flex-wrap justify-center gap-4">
          <a
            href="/get-quote"
            className="inline-flex items-center gap-2 bg-accent text-bg px-8 py-3.5 rounded-full font-semibold text-base no-underline transition-all hover:-translate-y-0.5 hover:shadow-[0_4px_30px_rgba(196,240,77,0.3)]"
          >
            Get a Free Quote &rarr;
          </a>
          <a
            href="https://wa.me/27731231909?text=Hi%20KasiTek%2C%20I'm%20interested%20in%20AI%20automation%20for%20my%20business"
            className="inline-flex items-center gap-2 border border-border-light text-text px-8 py-3.5 rounded-full font-medium text-base no-underline transition-all hover:border-text-muted"
          >
            Or Chat on WhatsApp
          </a>
        </div>
      </div>
    </section>
  );
}
