import { motion } from "framer-motion";
import { Bot, Megaphone, CheckCircle2 } from "lucide-react";

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
                  Got it! I've logged your job. Someone will confirm your booking within 15 minutes. 🔧
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
                  Hey {'{{name}}'} 👋 We're running a 20% off special this weekend only. Reply YES to claim yours!
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

        </div>
      </div>
    </section>
  );
}
