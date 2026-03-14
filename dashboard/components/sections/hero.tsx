"use client"

import { useEffect, useState } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { ArrowRight, Zap } from "lucide-react"
import Link from "next/link"

const headlines = [
  { text: ["Build your", "online presence."], className: "text-foreground" },
  { text: ["Automate customer", "conversations."], className: "text-primary" },
  { text: ["Grow with", "smarter systems."], className: "text-muted-foreground" },
]

export function Hero() {
  const [currentIndex, setCurrentIndex] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % headlines.length)
    }, 3000)
    return () => clearInterval(interval)
  }, [])

  return (
    <section className="relative min-h-screen flex flex-col justify-end overflow-hidden">
      {/* Background Effects */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_70%_40%,rgba(232,160,32,0.08),transparent_70%),radial-gradient(ellipse_40%_60%_at_10%_80%,rgba(61,186,122,0.05),transparent_60%)]" />
      <div 
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)`,
          backgroundSize: '80px 80px',
          maskImage: 'linear-gradient(to bottom, transparent 0%, black 30%, black 70%, transparent 100%)'
        }}
      />

      {/* Content */}
      <div className="relative z-10 px-6 md:px-12 lg:px-16 pb-24 md:pb-32">
        {/* Tag */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="inline-flex items-center gap-2 bg-primary/10 border border-primary/25 text-primary text-[11px] font-semibold tracking-[0.15em] uppercase px-4 py-1.5 mb-8 md:mb-10"
        >
          <Zap className="w-3 h-3" />
          Built for Growing SMBs
        </motion.div>

        {/* Rotating Headlines */}
        <div className="relative h-[140px] sm:h-[180px] md:h-[220px] lg:h-[280px] mb-10 md:mb-14">
          <AnimatePresence mode="wait">
            <motion.h1
              key={currentIndex}
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -30 }}
              transition={{ duration: 0.5, ease: "easeInOut" }}
              className={`absolute inset-0 font-display text-[clamp(3rem,9vw,9rem)] leading-[0.92] tracking-wide ${headlines[currentIndex].className}`}
              style={{ fontFamily: 'var(--font-display)' }}
            >
              {headlines[currentIndex].text.map((line, i) => (
                <span key={i} className="block">{line}</span>
              ))}
            </motion.h1>
          </AnimatePresence>
        </div>

        {/* Bottom Section */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.7 }}
          className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-20 items-end"
        >
          <p className="text-base md:text-lg text-muted-foreground leading-relaxed max-w-lg">
            <strong className="text-foreground font-medium">AI agents, marketing automation, and growth systems</strong> for businesses ready to scale. KasiTek gives you the tools and services to respond to every lead, run marketing campaigns, and grow without adding headcount.
          </p>
          
          <div className="flex flex-col gap-3 lg:items-end">
            <p className="text-[11px] font-semibold tracking-[0.15em] uppercase text-muted-foreground mb-1">
              Choose your path
            </p>
            <div className="flex flex-wrap gap-3">
              <Link
                href="#products"
                className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-6 py-3 text-sm font-bold tracking-wide hover:opacity-90 transition-all hover:-translate-y-0.5"
              >
                Explore Products
                <ArrowRight className="w-4 h-4" />
              </Link>
              <Link
                href="#services"
                className="inline-flex items-center gap-2 border border-border text-foreground px-6 py-3 text-sm font-semibold tracking-wide hover:border-muted-foreground transition-all hover:-translate-y-0.5"
              >
                Our Services
              </Link>
            </div>
          </div>
        </motion.div>
      </div>

      {/* Scroll Indicator */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.2 }}
        className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2"
      >
        <span className="text-[10px] tracking-[0.15em] uppercase text-muted-foreground">Scroll</span>
        <motion.div
          className="w-px h-10 bg-gradient-to-b from-primary to-transparent"
          animate={{ scaleY: [0, 1, 1, 0], originY: ["0%", "0%", "100%", "100%"] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
        />
      </motion.div>
    </section>
  )
}
