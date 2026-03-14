"use client"

import { motion, useInView } from "framer-motion"
import { useRef } from "react"
import Link from "next/link"
import { ArrowRight } from "lucide-react"

export function CTA() {
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: "-100px" })

  return (
    <section id="contact" ref={ref} className="relative px-6 md:px-12 lg:px-16 py-32 md:py-40 text-center overflow-hidden">
      {/* Background Glow */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="w-[600px] h-[600px] bg-[radial-gradient(circle,rgba(232,160,32,0.08),transparent_70%)]" />
      </div>

      <motion.div
        ref={ref}
        initial={{ opacity: 0, y: 40 }}
        animate={isInView ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.7 }}
        className="relative z-10 max-w-2xl mx-auto"
      >
        <span className="text-[10px] font-bold tracking-[0.2em] uppercase text-primary mb-4 block">
          Ready to start
        </span>
        <h2 
          className="text-3xl md:text-4xl lg:text-5xl xl:text-6xl leading-tight mb-5"
          style={{ fontFamily: 'var(--font-serif)' }}
        >
          Your business should be working while you sleep.
        </h2>
        <p className="text-base md:text-lg text-muted-foreground leading-relaxed mb-10 max-w-md mx-auto">
          Whether you want to self-serve with a product or have us build something custom — the next step is the same.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link
            href="mailto:hello@kasitek.co.za"
            className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-8 py-4 text-sm font-bold tracking-wide hover:opacity-90 transition-all hover:-translate-y-0.5"
          >
            Talk to KasiTek
            <ArrowRight className="w-4 h-4" />
          </Link>
          <Link
            href="#products"
            className="inline-flex items-center gap-2 border border-border text-foreground px-8 py-4 text-sm font-semibold tracking-wide hover:border-muted-foreground transition-all hover:-translate-y-0.5"
          >
            Explore Products
          </Link>
        </div>
      </motion.div>
    </section>
  )
}
