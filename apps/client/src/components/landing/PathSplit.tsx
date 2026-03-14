"use client";

import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";

export function PathSplit() {
  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <section className="px-6 md:px-12 py-24 border-y border-border bg-card/30" id="paths">
      <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-1 rounded-xl overflow-hidden bg-border">
        
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.5 }}
          onClick={() => scrollTo("products")}
          className="group relative bg-[#0D0D0D] p-10 md:p-16 cursor-pointer overflow-hidden flex flex-col justify-between min-h-[400px]"
        >
          {/* Top border reveal on hover */}
          <div className="absolute top-0 left-0 w-full h-[3px] bg-primary origin-left scale-x-0 group-hover:scale-x-100 transition-transform duration-500 ease-out z-20" />
          
          <div className="relative z-10">
            <span className="inline-block px-3 py-1 bg-white/5 border border-white/10 rounded text-xs font-medium text-muted-foreground mb-6 group-hover:bg-white/10 transition-colors">
              Self-Serve
            </span>
            <h3 className="font-display text-4xl mb-4 group-hover:text-primary transition-colors">Ready-to-use Products</h3>
            <p className="text-muted-foreground leading-relaxed max-w-md">
              Sign up, connect your channels, and go live. No technical setup required. Built for business owners who want results fast.
            </p>
          </div>

          <div className="relative z-10 mt-12 flex items-center text-sm font-semibold text-primary gap-2 group-hover:gap-4 transition-all">
            Explore Products <ArrowRight className="w-4 h-4" />
          </div>

          {/* Ghost Number */}
          <div className="absolute -bottom-8 -right-8 font-display text-[16rem] leading-none text-white/[0.02] group-hover:text-primary/[0.05] transition-colors pointer-events-none select-none">
            01
          </div>
        </motion.div>

        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.5, delay: 0.1 }}
          onClick={() => scrollTo("services")}
          className="group relative bg-[#0D0D0D] p-10 md:p-16 cursor-pointer overflow-hidden flex flex-col justify-between min-h-[400px]"
        >
          {/* Top border reveal on hover */}
          <div className="absolute top-0 left-0 w-full h-[3px] bg-primary origin-left scale-x-0 group-hover:scale-x-100 transition-transform duration-500 ease-out z-20" />
          
          <div className="relative z-10">
            <span className="inline-block px-3 py-1 bg-white/5 border border-white/10 rounded text-xs font-medium text-muted-foreground mb-6 group-hover:bg-white/10 transition-colors">
              Done For You
            </span>
            <h3 className="font-display text-4xl mb-4 group-hover:text-primary transition-colors">We Build It For You</h3>
            <p className="text-muted-foreground leading-relaxed max-w-md">
              Complex integrations, voice agents, custom workflows. We scope it, build it, and hand it over — or manage it for you on retainer.
            </p>
          </div>

          <div className="relative z-10 mt-12 flex items-center text-sm font-semibold text-white gap-2 group-hover:gap-4 transition-all group-hover:text-primary">
            See Services <ArrowRight className="w-4 h-4" />
          </div>

          {/* Ghost Number */}
          <div className="absolute -bottom-8 -right-8 font-display text-[16rem] leading-none text-white/[0.02] group-hover:text-primary/[0.05] transition-colors pointer-events-none select-none">
            02
          </div>
        </motion.div>

      </div>
    </section>
  );
}
