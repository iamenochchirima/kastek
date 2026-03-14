"use client"

import { motion } from "framer-motion"
import { useInView } from "framer-motion"
import { useRef } from "react"
import Link from "next/link"
import { ArrowRight } from "lucide-react"

const paths = [
  {
    type: "Self-Serve",
    title: "Ready-to-use Products",
    description: "Sign up, connect your channels, and go live. No technical setup required. Built for business owners who want results fast.",
    href: "#products",
    linkText: "Explore Products",
    number: "01"
  },
  {
    type: "Done For You",
    title: "We Build It For You",
    description: "Complex integrations, voice agents, custom workflows. We scope it, build it, and hand it over — or manage it for you on retainer.",
    href: "#services",
    linkText: "See Services",
    number: "02"
  }
]

export function PathSplit() {
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: "-100px" })

  return (
    <section ref={ref} className="px-6 md:px-12 lg:px-16 py-20 border-y border-border">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-border rounded-md overflow-hidden">
        {paths.map((path, index) => (
          <motion.div
            key={path.number}
            initial={{ opacity: 0, y: 30 }}
            animate={isInView ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.6, delay: index * 0.15 }}
          >
            <Link
              href={path.href}
              className="group relative block bg-card p-10 md:p-14 overflow-hidden hover:bg-secondary transition-colors"
            >
              {/* Top Accent Line */}
              <div className="absolute top-0 left-0 right-0 h-0.5 bg-primary scale-x-0 group-hover:scale-x-100 transition-transform origin-left" />
              
              {/* Background Number */}
              <span 
                className="absolute -bottom-6 right-5 text-[10rem] font-display leading-none text-foreground/[0.02] select-none pointer-events-none"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                {path.number}
              </span>

              <div className="relative z-10">
                <span className="text-[10px] font-bold tracking-[0.2em] uppercase text-primary mb-4 block">
                  {path.type}
                </span>
                <h3 
                  className="text-2xl md:text-3xl mb-4 leading-tight"
                  style={{ fontFamily: 'var(--font-serif)' }}
                >
                  {path.title}
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed mb-8 max-w-sm">
                  {path.description}
                </p>
                <span className="inline-flex items-center gap-2 text-sm font-semibold text-primary group-hover:gap-4 transition-all">
                  {path.linkText}
                  <ArrowRight className="w-4 h-4" />
                </span>
              </div>
            </Link>
          </motion.div>
        ))}
      </div>
    </section>
  )
}
