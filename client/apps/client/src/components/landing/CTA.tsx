"use client";

import { motion } from "framer-motion";

export function CTA() {
  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <section className="relative py-32 md:py-48 px-6 overflow-hidden flex flex-col items-center justify-center text-center" id="contact">
      {/* Huge subtle radial glow behind CTA */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-[radial-gradient(circle,rgba(232,160,32,0.08)_0%,transparent_60%)] pointer-events-none" />
      
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        className="relative z-10 flex flex-col items-center max-w-3xl mx-auto"
      >
        <p className="text-sm font-semibold tracking-wider text-primary uppercase mb-6">Ready to start</p>
        
        <h2 className="font-display text-5xl md:text-7xl lg:text-8xl leading-[0.9] mb-8 text-balance">
          Your business should be working <span className="font-serif italic text-white/70 font-normal">while you sleep.</span>
        </h2>
        
        <p className="text-muted-foreground text-lg mb-12 max-w-lg text-balance">
          Whether you want to self-serve with a product or have us build something custom — the next step is the same.
        </p>
        
        <div className="flex flex-col sm:flex-row gap-4 w-full sm:w-auto">
          <a 
            href="mailto:hello@kasitek.co.za" 
            className="px-8 py-4 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 hover:-translate-y-0.5 transition-all duration-200 shadow-[0_0_20px_rgba(232,160,32,0.2)] hover:shadow-[0_0_30px_rgba(232,160,32,0.4)] text-center"
          >
            Talk to KasiTek
          </a>
          <button 
            onClick={() => scrollTo("products")}
            className="px-8 py-4 rounded-lg bg-transparent text-foreground border border-border font-semibold hover:bg-white/5 hover:-translate-y-0.5 transition-all duration-200 text-center"
          >
            Explore Products
          </button>
        </div>
      </motion.div>
    </section>
  );
}
