"use client"

import { motion, useInView } from "framer-motion"
import { useRef } from "react"
import { ArrowRight, Bot, Megaphone, MessageSquare } from "lucide-react"
import Link from "next/link"

const products = [
  {
    id: "kasiagents",
    title: "KasiAgents",
    tagline: "Live",
    tagColor: "text-accent bg-accent/10 border-accent/20",
    icon: Bot,
    description: "AI agents for WhatsApp, your website, Facebook, and Instagram. Your agent responds instantly, qualifies leads, answers questions, and hands off to you — 24/7.",
    features: [
      "WhatsApp Business agent — responds to every message instantly",
      "Website chat agent — captures leads while you sleep",
      "Facebook & Instagram DM agent — no more missed comments",
      "Smart handoff — escalates to you when it matters",
      "Works in English, isiZulu, Afrikaans, and more"
    ],
    linkText: "Get early access",
    featured: true
  },
  {
    id: "kasireach",
    title: "KasiReach",
    tagline: "Coming Soon",
    tagColor: "text-muted-foreground bg-foreground/5 border-border",
    icon: Megaphone,
    description: "Send bulk WhatsApp campaigns to your entire customer list. Templates, scheduling, delivery reports. Think Mailchimp — but for WhatsApp.",
    features: [
      "Bulk WhatsApp messaging with approved templates",
      "Schedule campaigns in advance",
      "Segment your contacts by behaviour",
      "Track delivery and read rates",
      "Pairs directly with KasiAgents — your agent captures leads, KasiReach markets to them"
    ],
    linkText: "Join waitlist",
    featured: true
  }
]

function ChatDemo() {
  const messages = [
    { sender: "T", text: "Hi, what are your rates for a plumbing job in my area?", outgoing: false },
    { sender: "bot", text: "Hi Thabo! Our rates start from R450 for call-outs in your area. Can I get your address and a quick description of the issue?", outgoing: true },
    { sender: "T", text: "23 Berea Rd, burst geyser", outgoing: false },
    { sender: "bot", text: "Got it! I've logged your job. Someone will confirm your booking within 15 minutes. 🔧", outgoing: true },
  ]

  return (
    <div className="bg-primary/5 border border-primary/10 rounded-md p-6 h-full min-h-[260px] flex flex-col gap-3">
      {messages.map((msg, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.15 }}
          viewport={{ once: true }}
          className={`flex ${msg.outgoing ? "justify-end" : "items-start gap-2"}`}
        >
          {!msg.outgoing && (
            <div className="w-7 h-7 rounded-full bg-primary flex items-center justify-center text-xs font-bold text-primary-foreground flex-shrink-0">
              {msg.sender}
            </div>
          )}
          <div className={`px-3 py-2 text-xs leading-relaxed max-w-[240px] ${
            msg.outgoing 
              ? "bg-primary/15 border border-primary/25 rounded-lg rounded-tr-sm text-foreground" 
              : "bg-foreground/5 border border-foreground/10 rounded-lg rounded-tl-sm text-foreground"
          }`}>
            {msg.text}
          </div>
        </motion.div>
      ))}
      <div className="mt-auto flex items-center gap-2 px-3 py-2 bg-accent/10 border border-accent/20 rounded text-xs text-accent font-medium">
        <span className="w-1.5 h-1.5 bg-accent rounded-full animate-pulse" />
        Agent active — 0 missed messages today
      </div>
    </div>
  )
}

function CampaignDemo() {
  return (
    <div className="bg-primary/5 border border-primary/10 rounded-md p-6 h-full min-h-[260px] flex flex-col gap-3">
      <span className="text-[10px] font-bold tracking-[0.2em] uppercase text-muted-foreground">Campaign Preview</span>
      
      <div className="bg-foreground/5 border border-foreground/10 rounded-md p-3">
        <span className="text-[10px] text-muted-foreground block mb-1">{"To: All Customers (1,240)"}</span>
        <p className="text-xs text-foreground leading-relaxed">
          {"Hey {{name}} 👋 We're running a 20% off special this weekend only. Reply YES to claim yours!"}
        </p>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div className="bg-primary/10 border border-primary/20 rounded p-3 text-center">
          <span className="block text-2xl font-display text-primary" style={{ fontFamily: 'var(--font-display)' }}>94%</span>
          <span className="text-[10px] text-muted-foreground">Delivered</span>
        </div>
        <div className="bg-accent/10 border border-accent/20 rounded p-3 text-center">
          <span className="block text-2xl font-display text-accent" style={{ fontFamily: 'var(--font-display)' }}>61%</span>
          <span className="text-[10px] text-muted-foreground">Read</span>
        </div>
        <div className="bg-foreground/5 border border-foreground/10 rounded p-3 text-center">
          <span className="block text-2xl font-display text-foreground" style={{ fontFamily: 'var(--font-display)' }}>238</span>
          <span className="text-[10px] text-muted-foreground">Replies</span>
        </div>
      </div>

      <div className="mt-auto flex items-center gap-2 px-3 py-2 bg-accent/10 border border-accent/20 rounded text-xs text-accent font-medium">
        <span className="w-1.5 h-1.5 bg-accent rounded-full animate-pulse" />
        Campaign sent · 3 minutes ago
      </div>
    </div>
  )
}

export function Products() {
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: "-100px" })

  return (
    <section id="products" ref={ref} className="px-6 md:px-12 lg:px-16 py-24 md:py-32">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={isInView ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.6 }}
        className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-20 items-end mb-16"
      >
        <div>
          <span className="text-[10px] font-bold tracking-[0.2em] uppercase text-primary mb-4 block">
            Products
          </span>
          <h2 
            className="text-3xl md:text-4xl lg:text-5xl leading-tight"
            style={{ fontFamily: 'var(--font-serif)' }}
          >
            Tools you can run yourself
          </h2>
        </div>
        <p className="text-base text-muted-foreground leading-relaxed max-w-lg">
          Subscribe, connect, and start using. No agency calls, no waiting. Each product is built specifically for the way SMBs operate.
        </p>
      </motion.div>

      {/* Products Grid */}
      <div className="grid grid-cols-1 gap-px bg-border rounded-md overflow-hidden">
        {products.map((product, index) => (
          <motion.div
            key={product.id}
            initial={{ opacity: 0, y: 30 }}
            animate={isInView ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.6, delay: index * 0.15 }}
            className="bg-card p-8 md:p-12 hover:bg-secondary transition-colors"
          >
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-16 items-center">
              <div>
                <span className={`inline-block text-[9px] font-bold tracking-[0.15em] uppercase px-2.5 py-1 border mb-4 ${product.tagColor}`}>
                  {product.tagline === "Live" ? "● " : ""}{product.tagline}
                </span>
                
                <div className="w-11 h-11 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center mb-6">
                  <product.icon className="w-5 h-5 text-primary" />
                </div>

                <h3 
                  className="text-2xl md:text-3xl mb-3"
                  style={{ fontFamily: 'var(--font-serif)' }}
                >
                  {product.title}
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed mb-6">
                  {product.description}
                </p>

                <ul className="flex flex-col gap-2 mb-8">
                  {product.features.map((feature, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                      <ArrowRight className="w-3 h-3 text-primary mt-1.5 flex-shrink-0" />
                      {feature}
                    </li>
                  ))}
                </ul>

                <Link
                  href="#contact"
                  className="inline-flex items-center gap-2 text-sm font-semibold text-primary hover:gap-3 transition-all"
                >
                  {product.linkText}
                  <ArrowRight className="w-4 h-4" />
                </Link>
              </div>

              <div>
                {product.id === "kasiagents" ? <ChatDemo /> : <CampaignDemo />}
              </div>
            </div>
          </motion.div>
        ))}
      </div>
    </section>
  )
}
