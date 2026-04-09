"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

const headlines = [
  { top: "Build your", bottom: "online presence.", color: "text-foreground", glow: "rgba(255,255,255,0.05)" },
  { top: "Automate customer", bottom: "conversations.", color: "text-primary", glow: "rgba(232,160,32,0.15)" },
  { top: "Grow with", bottom: "smarter systems.", color: "text-muted-foreground", glow: "rgba(122,117,112,0.1)" },
];

export function Hero() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((prev) => (prev + 1) % headlines.length);
    }, 2800);
    return () => clearInterval(timer);
  }, []);

  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <section className="relative flex min-h-screen flex-col justify-end overflow-hidden px-6 pb-24 pt-24 md:justify-center md:px-12 md:pb-20 md:pt-28" id="home">
      {/* Background glow that matches the current headline color */}
      <div 
        className="absolute inset-0 transition-colors duration-1000 ease-in-out pointer-events-none"
        style={{
          background: `radial-gradient(circle at bottom center, ${headlines[index].glow} 0%, transparent 60%)`
        }}
      />

      <div className="max-w-7xl mx-auto w-full relative z-10 flex flex-col gap-8 md:gap-12">
        <div className="h-[120px] sm:h-[160px] md:h-[220px] relative">
          <AnimatePresence mode="wait">
            <motion.h1
              key={index}
              initial={{ opacity: 0, y: 30, filter: "blur(8px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -30, filter: "blur(8px)" }}
              transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
              className="absolute inset-0 font-display text-6xl sm:text-7xl md:text-9xl leading-[0.85] tracking-tight"
            >
              <span className="block text-foreground">{headlines[index].top}</span>
              <span className={cn("block transition-colors duration-300", headlines[index].color)}>
                {headlines[index].bottom}
              </span>
            </motion.h1>
          </AnimatePresence>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-12 md:gap-24 items-end mt-8 border-t border-border/50 pt-8">
          <div className="space-y-5 md:max-w-md">
            <motion.p 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4, duration: 0.6 }}
              className="text-muted-foreground text-sm sm:text-base leading-relaxed"
            >
              <strong className="text-foreground font-semibold">AI agents and growth systems</strong> for businesses. KasiTek provides products and services that help you respond faster, automate key workflows, and grow more efficiently.
            </motion.p>

            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.46, duration: 0.6 }}
              className="inline-flex w-fit rounded-full border border-primary/15 bg-primary/8 px-3 py-2 text-xs font-medium tracking-[0.02em] text-primary/90"
            >
              Custom services available. Products coming soon.
            </motion.p>
          </div>

          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5, duration: 0.6 }}
            className="flex flex-col gap-4"
          >
            <p className="text-xs font-semibold tracking-wider uppercase text-muted-foreground">Choose your path</p>
            <div className="flex flex-col sm:flex-row gap-4">
              <button 
                onClick={() => scrollTo("products")}
                className="px-8 py-4 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 hover:-translate-y-0.5 transition-all duration-200 shadow-[0_0_20px_rgba(232,160,32,0.3)] hover:shadow-[0_0_30px_rgba(232,160,32,0.5)]"
              >
                Explore Products
              </button>
              <button 
                onClick={() => scrollTo("services")}
                className="px-8 py-4 rounded-lg bg-card text-foreground border border-border font-semibold hover:bg-white/5 hover:-translate-y-0.5 transition-all duration-200"
              >
                Our Services
              </button>
            </div>
          </motion.div>
        </div>
      </div>

      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1, duration: 1 }}
        className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-3"
      >
        <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-semibold">Scroll</span>
        <motion.div 
          animate={{ y: [0, 8, 0], opacity: [0.3, 1, 0.3] }}
          transition={{ repeat: Infinity, duration: 2, ease: "easeInOut" }}
          className="h-10 w-[1px] bg-gradient-to-b from-primary/50 to-transparent"
        />
      </motion.div>
    </section>
  );
}
