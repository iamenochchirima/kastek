"use client";

import { motion } from "framer-motion";
import { Bot, CalendarRange, CheckCircle2, Megaphone, Wand2 } from "lucide-react";

export function Products() {
  return (
    <section className="px-6 md:px-12 py-24 md:py-32" id="products">
      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12 mb-16 md:mb-24 items-end">
          <div>
            <p className="text-sm font-semibold tracking-wider text-primary uppercase mb-4">Products</p>
            <h2 className="font-display text-5xl md:text-7xl">Tools you can<br/>run yourself</h2>
          </div>
          <p className="text-muted-foreground md:max-w-md text-base leading-relaxed">
            Subscribe, connect, and start using. No agency calls, no waiting. Each product is built specifically for the way SMBs operate.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 bg-border p-[1px] rounded-2xl overflow-hidden">
          
          {/* PRODUCT 1: KasiAgents */}
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="bg-[#0D0D0D] rounded-xl p-8 md:p-12 grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-24 relative overflow-hidden"
          >
            {/* Content Side */}
            <div className="flex flex-col z-10">
              <div className="flex items-center gap-3 mb-8">
                <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-primary/10 text-primary border border-primary/20">
                  <Bot className="w-6 h-6" />
                </div>
                <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-accent/10 border border-accent/20 text-accent text-xs font-semibold tracking-wide">
                  <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                  Live
                </div>
              </div>
              
              <h3 className="font-display text-4xl mb-4">KasiAgents</h3>
              <p className="text-muted-foreground mb-8 leading-relaxed">
                AI agents for WhatsApp, your website, Facebook, and Instagram. Your agent responds instantly, qualifies leads, answers questions, and hands off to you — 24/7.
              </p>

              <ul className="flex flex-col gap-3 mb-10">
                {[
                  "WhatsApp Business agent — responds to every message instantly",
                  "Website chat agent — captures leads while you sleep",
                  "Facebook & Instagram DM agent — no more missed comments",
                  "Smart handoff — escalates to you when it matters",
                  "Works in English, isiZulu, Afrikaans, and more"
                ].map((feature, i) => (
                  <li key={i} className="flex items-start gap-3 text-sm text-foreground/80">
                    <CheckCircle2 className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-auto">
                <a href="#contact" className="inline-flex items-center font-semibold text-primary hover:text-primary-foreground hover:bg-primary px-5 py-2.5 rounded-lg transition-colors border border-primary">
                  Get early access &rarr;
                </a>
              </div>
            </div>

            {/* Visual Side - Chat Mock */}
            <div className="bg-card rounded-xl border border-border p-6 flex flex-col gap-4 relative z-10 shadow-2xl shadow-black/50 h-full min-h-[350px]">
              
              <div className="flex gap-3 items-end">
                <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-xs font-bold text-primary-foreground shrink-0 shadow-lg shadow-primary/20">T</div>
                <div className="bg-white/5 border border-white/10 rounded-2xl rounded-bl-sm px-4 py-3 text-sm text-foreground max-w-[85%]">
                  Hi, what are your rates for a plumbing job in my area?
                </div>
              </div>

              <div className="flex gap-3 items-end justify-end">
                <div className="bg-primary/10 border border-primary/20 rounded-2xl rounded-br-sm px-4 py-3 text-sm text-foreground max-w-[85%]">
                  Hi Thabo! Our rates start from R450 for call-outs in your area. Can I get your address and a quick description of the issue?
                </div>
              </div>

              <div className="flex gap-3 items-end">
                <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-xs font-bold text-primary-foreground shrink-0 shadow-lg shadow-primary/20">T</div>
                <div className="bg-white/5 border border-white/10 rounded-2xl rounded-bl-sm px-4 py-3 text-sm text-foreground max-w-[85%]">
                  23 Berea Rd, burst geyser
                </div>
              </div>

              <div className="flex gap-3 items-end justify-end">
                <div className="bg-primary/10 border border-primary/20 rounded-2xl rounded-br-sm px-4 py-3 text-sm text-foreground max-w-[85%]">
                  Got it! I&apos;ve logged your job. Someone will confirm your booking within 15 minutes. 🔧
                </div>
              </div>

              <div className="mt-auto pt-4 border-t border-border">
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-accent/5 border border-accent/10 text-xs font-medium text-accent">
                  <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                  Agent active — 0 missed messages today
                </div>
              </div>
            </div>
            
            {/* Decorative background gradient */}
            <div className="absolute top-1/2 right-0 -translate-y-1/2 w-[500px] h-[500px] bg-primary/5 blur-[100px] rounded-full pointer-events-none" />
          </motion.div>

          {/* PRODUCT 2: KasiReach */}
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="bg-[#0D0D0D] rounded-xl p-8 md:p-12 grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-24 relative overflow-hidden"
          >
            {/* Content Side */}
            <div className="flex flex-col z-10">
              <div className="flex items-center gap-3 mb-8">
                <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-white/5 text-foreground border border-white/10">
                  <Megaphone className="w-6 h-6" />
                </div>
                <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-muted-foreground text-xs font-semibold tracking-wide">
                  Coming Soon
                </div>
              </div>
              
              <h3 className="font-display text-4xl mb-4">KasiReach</h3>
              <p className="text-muted-foreground mb-8 leading-relaxed">
                Send bulk WhatsApp campaigns to your entire customer list. Templates, scheduling, delivery reports. Think Mailchimp — but for WhatsApp.
              </p>

              <ul className="flex flex-col gap-3 mb-10">
                {[
                  "Bulk WhatsApp messaging with approved templates",
                  "Schedule campaigns in advance",
                  "Segment your contacts by behaviour",
                  "Track delivery and read rates",
                  "Pairs directly with KasiAgents"
                ].map((feature, i) => (
                  <li key={i} className="flex items-start gap-3 text-sm text-foreground/80">
                    <CheckCircle2 className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-auto">
                <a href="#contact" className="inline-flex items-center font-semibold text-foreground hover:text-primary transition-colors">
                  Join waitlist &rarr;
                </a>
              </div>
            </div>

            {/* Visual Side - Campaign Mock */}
            <div className="bg-card rounded-xl border border-border p-6 flex flex-col gap-4 relative z-10 shadow-2xl shadow-black/50 h-full min-h-[350px]">
              
              <div className="text-[10px] tracking-[0.2em] uppercase text-muted-foreground font-semibold">Campaign Preview</div>
              
              <div className="bg-white/5 border border-white/10 rounded-lg p-5">
                <div className="text-xs text-muted-foreground mb-3 flex items-center justify-between">
                  <span>To: All Customers (1,240)</span>
                  <span className="px-2 py-0.5 bg-primary/20 text-primary rounded text-[10px]">Marketing</span>
                </div>
                <div className="text-sm text-foreground leading-relaxed">
                  Hey {'{{name}}'} 👋 We&apos;re running a 20% off special this weekend only. Reply YES to claim yours!
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3 mt-4">
                <div className="bg-primary/10 border border-primary/20 rounded-lg p-4 text-center flex flex-col justify-center">
                  <div className="font-display text-3xl text-primary leading-none mb-1">94%</div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Delivered</div>
                </div>
                <div className="bg-accent/10 border border-accent/20 rounded-lg p-4 text-center flex flex-col justify-center">
                  <div className="font-display text-3xl text-accent leading-none mb-1">61%</div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Read</div>
                </div>
                <div className="bg-white/5 border border-white/10 rounded-lg p-4 text-center flex flex-col justify-center">
                  <div className="font-display text-3xl text-foreground leading-none mb-1">238</div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Replies</div>
                </div>
              </div>

              <div className="mt-auto pt-4 border-t border-border">
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-xs font-medium text-muted-foreground">
                  <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground" />
                  Campaign sent · 3 minutes ago
                </div>
              </div>
            </div>
          </motion.div>

          {/* PRODUCT 3: KasiSocial */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="bg-[#0D0D0D] rounded-xl p-8 md:p-12 grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-24 relative overflow-hidden"
          >
            <div className="flex flex-col z-10">
              <div className="flex items-center gap-3 mb-8">
                <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-white/5 text-foreground border border-white/10">
                  <CalendarRange className="w-6 h-6" />
                </div>
                <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-muted-foreground text-xs font-semibold tracking-wide">
                  Coming Soon
                </div>
              </div>

              <h3 className="font-display text-4xl mb-4">KasiSocial</h3>
              <p className="text-muted-foreground mb-8 leading-relaxed">
                Schedule, publish, and grow your social media presence from one place. Write once
                — post everywhere. AI helps you create content that actually sounds like your
                business.
              </p>

              <ul className="flex flex-col gap-3 mb-10">
                {[
                  "Post to Facebook, Instagram, LinkedIn, and X simultaneously",
                  "AI caption generator — describe your offer, get post-ready copy instantly",
                  "Visual content calendar — see your whole month at a glance",
                  "WhatsApp Status scheduling — the gap no other tool fills",
                  "Post performance analytics per channel",
                ].map((feature, i) => (
                  <li key={i} className="flex items-start gap-3 text-sm text-foreground/80">
                    <CheckCircle2 className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-auto">
                <a href="#contact" className="inline-flex items-center font-semibold text-foreground hover:text-primary transition-colors">
                  Join waitlist &rarr;
                </a>
              </div>
            </div>

            <div className="bg-card rounded-xl border border-border p-6 flex flex-col gap-4 relative z-10 shadow-2xl shadow-black/50 h-full min-h-[350px]">
              <div className="flex items-center justify-between">
                <div className="text-[10px] tracking-[0.2em] uppercase text-muted-foreground font-semibold">
                  Content Studio
                </div>
                <div className="rounded-full border border-primary/15 bg-primary/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">
                  Multi-channel
                </div>
              </div>

              <div className="rounded-xl border border-white/10 bg-white/[0.04] p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                      New Post
                    </div>
                    <div className="mt-2 text-sm text-foreground leading-relaxed">
                      &quot;We&apos;re open this Sunday and taking bookings all day...&quot;
                    </div>
                  </div>
                  <div className="inline-flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/10 px-3 py-2 text-xs font-semibold text-primary">
                    <Wand2 className="h-3.5 w-3.5" />
                    AI Generate
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                <div className="text-[10px] tracking-[0.16em] uppercase text-muted-foreground font-semibold">
                  Publishing to
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-foreground/85">
                  {["Facebook", "Instagram", "LinkedIn", "WhatsApp Status"].map((channel) => (
                    <div
                      key={channel}
                      className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2"
                    >
                      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary/15 text-primary">
                        ✓
                      </span>
                      {channel}
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                <div className="grid grid-cols-5 gap-2 text-center text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  {["Mon", "Tue", "Wed", "Thu", "Fri"].map((day) => (
                    <div key={day}>{day}</div>
                  ))}
                </div>
                <div className="mt-4 grid grid-cols-5 gap-2">
                  {[
                    "bg-primary",
                    "",
                    "bg-accent",
                    "",
                    "bg-primary",
                    "",
                    "bg-white/20",
                    "",
                    "bg-primary",
                    "",
                  ].map((dotClass, index) => (
                    <div
                      key={index}
                      className="flex h-10 items-center justify-center rounded-lg border border-white/6 bg-white/[0.02]"
                    >
                      {dotClass ? <span className={`h-2.5 w-2.5 rounded-full ${dotClass}`} /> : null}
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-auto pt-4 border-t border-border">
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-accent/5 border border-accent/10 text-xs font-medium text-accent">
                  <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                  3 posts scheduled this week
                </div>
              </div>
            </div>

            <div className="absolute top-1/2 right-0 -translate-y-1/2 w-[500px] h-[500px] bg-accent/5 blur-[100px] rounded-full pointer-events-none" />
          </motion.div>

        </div>
      </div>
    </section>
  );
}
