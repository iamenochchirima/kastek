"use client";

import { useState, useEffect, useRef } from "react";
import { Sparkles } from "lucide-react";
import type { SolutionDemoKind, SolutionService } from "@/app/(marketing)/solutions/data";

// ── Loop engine ─────────────────────────────────────────────────────────────
function useLoop(totalSteps: number, stepMs: number, holdMs = 2800) {
  const [step, setStep] = useState(0);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    function schedule() {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
      setStep(0);
      for (let i = 1; i <= totalSteps; i++) {
        const t = setTimeout(() => setStep(i), i * stepMs);
        timersRef.current.push(t);
      }
      const loop = setTimeout(schedule, totalSteps * stepMs + holdMs);
      timersRef.current.push(loop);
    }
    const init = setTimeout(schedule, 200);
    return () => {
      clearTimeout(init);
      timersRef.current.forEach(clearTimeout);
    };
  }, [totalSteps, stepMs, holdMs]);

  return step;
}

// ── Shared shell ─────────────────────────────────────────────────────────────
function DemoShell({ label, badge = "Live Demo", children }: { label: string; badge?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl overflow-hidden border border-white/8 bg-[#080808]">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/8 bg-[#0D0D0D]">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-[#3DBA7A] animate-pulse" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/40">{label}</span>
        </div>
        <span className="text-[9px] font-semibold uppercase tracking-[0.15em] border border-white/10 text-white/30 px-2 py-0.5 rounded-full">{badge}</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

// ── Shared bubble helpers ────────────────────────────────────────────────────
function Bubble({ dir, children, visible, delay = 0 }: { dir: "in" | "out"; children: React.ReactNode; visible: boolean; delay?: number }) {
  return (
    <div
      className={`flex ${dir === "out" ? "justify-end" : "justify-start"} transition-all duration-500`}
      style={{ opacity: visible ? 1 : 0, transform: visible ? "translateY(0)" : "translateY(8px)", transitionDelay: `${delay}ms` }}
    >
      <div className={`max-w-[80%] px-3 py-2 text-[11px] leading-relaxed rounded-2xl ${dir === "out" ? "bg-[#E8A020]/20 text-[#F5D080] rounded-br-sm" : "bg-white/8 text-white/80 rounded-bl-sm"}`}>
        {children}
      </div>
    </div>
  );
}

function WaBubble({ dir, children, visible, delay = 0 }: { dir: "in" | "out"; children: React.ReactNode; visible: boolean; delay?: number }) {
  return (
    <div
      className={`flex ${dir === "out" ? "justify-end" : "justify-start"} transition-all duration-500`}
      style={{ opacity: visible ? 1 : 0, transform: visible ? "translateY(0)" : "translateY(6px)", transitionDelay: `${delay}ms` }}
    >
      <div className={`max-w-[82%] px-3 py-2 text-[11px] leading-relaxed shadow-sm ${dir === "out" ? "rounded-[12px_0_12px_12px] text-gray-800" : "rounded-[0_12px_12px_12px] text-gray-800 bg-white"}`}
        style={dir === "out" ? { background: "#dcf8c6" } : {}}>
        {children}
      </div>
    </div>
  );
}

function TypingDots({ visible }: { visible: boolean }) {
  return (
    <div className={`flex justify-start transition-opacity duration-300 ${visible ? "opacity-100" : "opacity-0"}`}>
      <div className="bg-white/8 rounded-[0_12px_12px_12px] px-3 py-2 flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <span key={i} className="w-1.5 h-1.5 rounded-full bg-white/40" style={{ animation: `bounce 1s ease infinite ${i * 0.15}s` }} />
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DEMO COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

function WebsiteAgentDemo() {
  const step = useLoop(6, 900, 3000);
  return (
    <DemoShell label="Website Agent">
      {/* Blurred page background */}
      <div className="relative rounded-xl bg-[#111] overflow-hidden" style={{ minHeight: 280 }}>
        {/* Fake page content */}
        <div className="p-4 select-none pointer-events-none opacity-30">
          <div className="h-3 bg-white/20 rounded w-1/3 mb-2" />
          <div className="h-2 bg-white/15 rounded w-2/3 mb-1.5" />
          <div className="h-2 bg-white/15 rounded w-1/2 mb-4" />
          <div className="grid grid-cols-3 gap-2 mb-4">
            {[1,2,3].map(i => <div key={i} className="h-14 bg-white/10 rounded-lg" />)}
          </div>
          <div className="h-2 bg-white/15 rounded w-full mb-1.5" />
          <div className="h-2 bg-white/15 rounded w-4/5" />
        </div>

        {/* Chat widget */}
        <div className="absolute bottom-3 right-3 flex flex-col items-end gap-2" style={{ width: 230 }}>
          {/* Chat window */}
          <div
            className="w-full rounded-xl overflow-hidden shadow-2xl border border-white/10 transition-all duration-500"
            style={{ opacity: step >= 1 ? 1 : 0, transform: step >= 1 ? "scale(1) translateY(0)" : "scale(0.95) translateY(8px)" }}
          >
            <div className="bg-[#2D9A62] px-3 py-2 flex items-center gap-2">
              <div className="relative">
                <div className="w-6 h-6 rounded-full bg-white/20 flex items-center justify-center text-[10px] font-bold text-white">K</div>
                <div className="absolute -bottom-0.5 -right-0.5 w-2 h-2 bg-green-300 rounded-full border border-[#2D9A62]" />
              </div>
              <div>
                <p className="text-white text-[10px] font-semibold leading-tight">KasiTek Assistant</p>
                <p className="text-green-200 text-[9px]">Online · replies instantly</p>
              </div>
            </div>

            <div className="p-2.5 space-y-2" style={{ background: "#f0f4f8", minHeight: 130 }}>
              {/* Agent greeting */}
              <div className="flex gap-1.5 items-end">
                <div className="w-4 h-4 rounded-full bg-[#2D9A62] flex items-center justify-center text-[8px] text-white font-bold flex-shrink-0 mb-0.5">K</div>
                <div
                  className="bg-white rounded-xl rounded-bl-sm px-2.5 py-1.5 text-[10px] text-gray-800 shadow-sm max-w-[90%] transition-all duration-400"
                  style={{ opacity: step >= 1 ? 1 : 0, transform: step >= 1 ? "translateY(0)" : "translateY(4px)" }}
                >
                  Hi! 👋 How can I help you today?
                </div>
              </div>

              {/* Quick replies */}
              <div
                className="flex gap-1 ml-5 flex-wrap transition-all duration-400"
                style={{ opacity: step >= 2 ? 1 : 0, transform: step >= 2 ? "translateY(0)" : "translateY(4px)", transitionDelay: "100ms" }}
              >
                {["Request Demo", "Get Pricing", "Talk to Sales"].map((label, i) => (
                  <button key={label} className={`text-white text-[9px] px-2 py-0.5 rounded-full font-medium transition-colors ${step >= 4 && i === 0 ? "bg-[#1d7a4c]" : "bg-[#2D9A62]"}`}>
                    {label}
                  </button>
                ))}
              </div>

              {/* User reply */}
              <div
                className="flex justify-end transition-all duration-400"
                style={{ opacity: step >= 3 ? 1 : 0, transform: step >= 3 ? "translateY(0)" : "translateY(4px)" }}
              >
                <div className="bg-[#2D9A62] rounded-xl rounded-br-sm px-2.5 py-1.5 text-[10px] text-white max-w-[80%]">
                  I&apos;d like to request a demo
                </div>
              </div>

              {/* Agent form */}
              <div
                className="flex gap-1.5 items-end transition-all duration-500"
                style={{ opacity: step >= 4 ? 1 : 0, transform: step >= 4 ? "translateY(0)" : "translateY(6px)" }}
              >
                <div className="w-4 h-4 rounded-full bg-[#2D9A62] flex items-center justify-center text-[8px] text-white font-bold flex-shrink-0 mb-0.5">K</div>
                <div className="bg-white rounded-xl rounded-bl-sm px-2.5 py-2 text-[10px] text-gray-800 shadow-sm max-w-[90%] space-y-1.5">
                  <p className="font-semibold text-gray-900 text-[10px]">Quick details:</p>
                  {["Your name", "Email address"].map((f, i) => (
                    <div key={f} className="bg-gray-100 rounded-md px-2 py-1 text-[9px] text-gray-400">{f}</div>
                  ))}
                  <button className="w-full bg-[#2D9A62] text-white text-[9px] py-1 rounded-md font-semibold">
                    Book Demo →
                  </button>
                </div>
              </div>
            </div>

            {/* Input bar */}
            <div className="bg-white px-2.5 py-2 flex items-center gap-1.5 border-t border-gray-100">
              <div className="flex-1 bg-gray-100 rounded-full px-2.5 py-1 text-[9px] text-gray-400">Type a message...</div>
              <div className="w-6 h-6 rounded-full bg-[#2D9A62] flex items-center justify-center flex-shrink-0">
                <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
              </div>
            </div>
          </div>

          {/* Launcher button */}
          <button className="w-10 h-10 rounded-full bg-[#2D9A62] flex items-center justify-center shadow-xl">
            <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg>
          </button>
        </div>
      </div>
    </DemoShell>
  );
}

function WhatsAppAgentDemo() {
  const step = useLoop(7, 800, 3000);
  const messages = [
    { dir: "out" as const, text: "Can I book for tomorrow morning?", showAt: 1 },
    { dir: "in" as const, text: "Yes. I have 9am and 11am open.", showAt: 3 },
    { dir: "out" as const, text: "9am works. 14 Elm Street.", showAt: 4 },
    { dir: "in" as const, text: "Booked ✓ Confirmation sent!", showAt: 6, green: true },
  ];

  return (
    <DemoShell label="WhatsApp Agent">
      <div className="rounded-xl overflow-hidden border border-white/10 shadow-xl max-w-xs mx-auto">
        {/* WA header */}
        <div className="flex items-center gap-2 px-3 py-2 bg-[#2D9A62]">
          <div className="w-7 h-7 rounded-full bg-white/20 flex items-center justify-center text-sm">🤖</div>
          <div>
            <p className="text-white text-[11px] font-semibold leading-tight">KasiTek AI</p>
            <p className="text-green-200 text-[9px]">Typically replies instantly</p>
          </div>
        </div>

        {/* Chat area */}
        <div className="px-2.5 py-2.5 space-y-2" style={{ background: "#ece5dd", minHeight: 220 }}>
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.dir === "out" ? "justify-end" : "justify-start"} transition-all duration-500`}
              style={{ opacity: step >= m.showAt ? 1 : 0, transform: step >= m.showAt ? "translateY(0)" : "translateY(6px)" }}>
              <div className={`max-w-[82%] px-3 py-1.5 text-[11px] leading-relaxed shadow-sm ${m.dir === "out" ? "rounded-[12px_0_12px_12px]" : "rounded-[0_12px_12px_12px] bg-white"}`}
                style={m.dir === "out" ? { background: "#dcf8c6", color: "#1a1a1a" } : { color: "#1a1a1a" }}>
                {m.text}
              </div>
            </div>
          ))}
          {/* Typing indicator */}
          <div className={`flex justify-start transition-all duration-300`} style={{ opacity: step === 2 || step === 5 ? 1 : 0 }}>
            <div className="bg-white rounded-[0_12px_12px_12px] px-3 py-2 flex gap-1 shadow-sm">
              {[0,1,2].map(i => <span key={i} className="w-1.5 h-1.5 rounded-full bg-gray-400" style={{ animation: `bounce 1s ease infinite ${i*0.15}s` }} />)}
            </div>
          </div>
          {/* Booking card */}
          <div className="flex justify-start transition-all duration-500"
            style={{ opacity: step >= 7 ? 1 : 0, transform: step >= 7 ? "translateY(0)" : "translateY(6px)" }}>
            <div className="bg-white rounded-[0_12px_12px_12px] overflow-hidden shadow-sm max-w-[85%]">
              <div className="bg-[#2D9A62] px-3 py-1.5 flex items-center gap-1.5">
                <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                <span className="text-white text-[10px] font-semibold">Appointment Confirmed</span>
              </div>
              <div className="p-2.5">
                <p className="text-[11px] font-semibold text-gray-800">Tomorrow · 09:00</p>
                <p className="text-[10px] text-gray-500">14 Elm Street</p>
              </div>
            </div>
          </div>
        </div>

        {/* Input */}
        <div className="bg-[#f0f0f0] px-2.5 py-2 flex items-center gap-2">
          <div className="flex-1 bg-white rounded-full px-3 py-1 text-[10px] text-gray-400 shadow-sm">Message...</div>
          <div className="w-6 h-6 rounded-full bg-[#2D9A62] flex items-center justify-center">
            <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/></svg>
          </div>
        </div>
      </div>
    </DemoShell>
  );
}

function CatalogueAgentDemo() {
  const step = useLoop(6, 900, 3200);
  const products = [
    { name: "5kWh LiFePO4 Battery", price: "R 8,990", emoji: "🔋", at: 3 },
    { name: "10kWh Premium Pack", price: "R 16,500", emoji: "⚡", at: 4 },
    { name: "3kWh Compact Unit", price: "R 5,400", emoji: "🔌", at: 5 },
  ];

  return (
    <DemoShell label="Catalogue Agent">
      <div className="rounded-xl overflow-hidden border border-white/10 shadow-xl max-w-xs mx-auto">
        <div className="flex items-center gap-2 px-3 py-2 bg-[#2D9A62]">
          <div className="w-7 h-7 rounded-full bg-white/20 flex items-center justify-center text-sm">🛍️</div>
          <div>
            <p className="text-white text-[11px] font-semibold">KasiTek Shop</p>
            <p className="text-green-200 text-[9px]">Product catalogue</p>
          </div>
        </div>

        <div className="px-2.5 py-2.5 space-y-2" style={{ background: "#ece5dd", minHeight: 240 }}>
          {/* User query */}
          <div className="flex justify-end transition-all duration-500" style={{ opacity: step >= 1 ? 1 : 0, transform: step >= 1 ? "none" : "translateY(6px)" }}>
            <div className="px-3 py-1.5 text-[11px] leading-relaxed rounded-[12px_0_12px_12px] shadow-sm" style={{ background: "#dcf8c6", color: "#1a1a1a" }}>
              Show me solar batteries under R10k
            </div>
          </div>

          {/* Typing */}
          <div className="flex justify-start" style={{ opacity: step === 2 ? 1 : 0, transition: "opacity 0.3s" }}>
            <div className="bg-white rounded-[0_12px_12px_12px] px-3 py-2 flex gap-1 shadow-sm">
              {[0,1,2].map(i => <span key={i} className="w-1.5 h-1.5 rounded-full bg-gray-400" style={{ animation: `bounce 1s ease infinite ${i*0.15}s` }} />)}
            </div>
          </div>

          {/* Agent text */}
          <div className="flex justify-start transition-all duration-500" style={{ opacity: step >= 3 ? 1 : 0, transform: step >= 3 ? "none" : "translateY(4px)" }}>
            <div className="bg-white rounded-[0_12px_12px_12px] px-3 py-1.5 text-[11px] text-gray-800 shadow-sm max-w-[85%]">
              Found 3 options matching your budget:
            </div>
          </div>

          {/* Product cards */}
          <div className="space-y-1.5">
            {products.map((p, i) => (
              <div key={i} className="bg-white rounded-xl overflow-hidden shadow-sm transition-all duration-500 flex items-center gap-2 p-2"
                style={{ opacity: step >= p.at ? 1 : 0, transform: step >= p.at ? "none" : "translateY(4px)" }}>
                <span className="text-xl flex-shrink-0">{p.emoji}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-semibold text-gray-800 truncate">{p.name}</p>
                  <p className="text-[10px] text-[#2D9A62] font-bold">{p.price}</p>
                </div>
                <button className="text-[9px] border border-[#2D9A62] text-[#2D9A62] px-1.5 py-0.5 rounded-md flex-shrink-0 font-medium">Quote</button>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-[#f0f0f0] px-2.5 py-2 flex items-center gap-2">
          <div className="flex-1 bg-white rounded-full px-3 py-1 text-[10px] text-gray-400 shadow-sm">Message...</div>
          <div className="w-6 h-6 rounded-full bg-[#2D9A62] flex items-center justify-center">
            <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/></svg>
          </div>
        </div>
      </div>
    </DemoShell>
  );
}

function QuoteDemo() {
  const step = useLoop(7, 700, 3000);
  const items = [
    { label: "8× Circuit Breaker 20A", amount: "R 1,240" },
    { label: "4× Distribution Board", amount: "R 3,600" },
    { label: "12m Cable 2.5mm", amount: "R 480" },
  ];

  return (
    <DemoShell label="Quote Automation">
      <div className="rounded-xl border border-white/10 overflow-hidden bg-white shadow-xl max-w-sm mx-auto">
        {/* Doc header */}
        <div className="bg-[#E8A020] px-4 py-2.5 flex items-center gap-2 transition-all duration-500"
          style={{ opacity: step >= 1 ? 1 : 0, transform: step >= 1 ? "none" : "translateY(-4px)" }}>
          <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
          <span className="text-white text-xs font-semibold">Quotation_001.pdf</span>
          <span className="ml-auto text-[10px] text-amber-100">Electrical Equipment</span>
        </div>

        <div className="p-3 space-y-2">
          {/* Customer details */}
          <div className="transition-all duration-500" style={{ opacity: step >= 1 ? 1 : 0 }}>
            <p className="text-[10px] text-gray-500">To: Khumalo Electrical · {new Date().toLocaleDateString("en-ZA")}</p>
          </div>

          {/* Line items */}
          <div className="space-y-1.5">
            {items.map((item, i) => (
              <div key={i} className="flex justify-between items-center py-1.5 border-b border-gray-100 transition-all duration-500"
                style={{ opacity: step >= i + 2 ? 1 : 0, transform: step >= i + 2 ? "none" : "translateX(-6px)" }}>
                <span className="text-[11px] text-gray-700">{item.label}</span>
                <span className="text-[11px] font-semibold text-gray-800">{item.amount}</span>
              </div>
            ))}
          </div>

          {/* Total */}
          <div className="flex justify-between items-center pt-1.5 transition-all duration-500"
            style={{ opacity: step >= 5 ? 1 : 0 }}>
            <span className="text-xs font-bold text-gray-900">Total</span>
            <span className="text-sm font-bold text-[#E8A020]">R 5,320</span>
          </div>

          {/* Action row */}
          <div className="flex gap-2 pt-1 transition-all duration-500"
            style={{ opacity: step >= 6 ? 1 : 0, transform: step >= 6 ? "none" : "translateY(4px)" }}>
            <button className="flex-1 bg-[#E8A020] text-white text-[10px] py-1.5 rounded-lg font-semibold">Download PDF</button>
            <button className="flex-1 bg-[#2D9A62] text-white text-[10px] py-1.5 rounded-lg font-semibold">Send to Client</button>
          </div>

          {/* Sent confirmation */}
          <div className="flex items-center gap-2 text-[10px] text-[#2D9A62] font-semibold transition-all duration-500"
            style={{ opacity: step >= 7 ? 1 : 0 }}>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7"/></svg>
            Delivered via WhatsApp & Email
          </div>
        </div>
      </div>
    </DemoShell>
  );
}

function VoiceDemo() {
  const step = useLoop(6, 900, 3000);
  const transcript = [
    { speaker: "Caller", text: "I need to book an electrical inspection.", at: 2 },
    { speaker: "Agent", text: "I can help. What's your address?", at: 3 },
    { speaker: "Caller", text: "14 Elm Street, Soweto.", at: 4 },
    { speaker: "Agent", text: "Booked for Friday 10am. Confirmation sent.", at: 5 },
  ];

  const bars = [4, 7, 5, 9, 6, 8, 4, 7, 5, 9, 6, 3, 8, 5, 7];

  return (
    <DemoShell label="Voice Agent">
      <div className="space-y-4">
        {/* Call visualization */}
        <div className="rounded-xl border border-white/8 bg-[#0D0D0D] p-4">
          <div className="flex items-center gap-3 mb-4">
            <div className="relative">
              <div className={`w-10 h-10 rounded-full bg-[#2D9A62]/20 border border-[#2D9A62]/40 flex items-center justify-center transition-all duration-300 ${step >= 1 ? "scale-100" : "scale-90 opacity-50"}`}>
                <svg className="w-5 h-5 text-[#2D9A62]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 7V5z"/></svg>
              </div>
              {step >= 1 && step <= 5 && (
                <span className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-[#3DBA7A] border-2 border-[#0D0D0D] animate-pulse" />
              )}
            </div>
            <div>
              <p className="text-white text-xs font-semibold">+27 11 555 0100</p>
              <p className={`text-[10px] transition-colors duration-300 ${step >= 1 ? "text-[#3DBA7A]" : "text-white/30"}`}>
                {step === 0 ? "Incoming call…" : step >= 6 ? "Call ended" : "Connected · 00:3" + step}
              </p>
            </div>
            {step >= 1 && step <= 5 && (
              <div className="ml-auto flex items-end gap-0.5 h-6">
                {bars.map((h, i) => (
                  <div key={i} className="w-1 rounded-sm bg-[#3DBA7A] transition-all duration-150"
                    style={{ height: `${(step >= 2 ? h : 2)}px`, opacity: step >= 2 ? 0.6 + (i % 3) * 0.2 : 0.3, animationDelay: `${i * 0.05}s` }} />
                ))}
              </div>
            )}
          </div>

          {/* Transcript */}
          <div className="space-y-2">
            {transcript.map((t, i) => (
              <div key={i} className={`flex ${t.speaker === "Agent" ? "justify-start" : "justify-end"} transition-all duration-500`}
                style={{ opacity: step >= t.at ? 1 : 0, transform: step >= t.at ? "none" : "translateY(4px)" }}>
                <div className="max-w-[85%]">
                  <p className="text-[9px] font-semibold uppercase tracking-wide mb-0.5 px-1" style={{ color: t.speaker === "Agent" ? "#3DBA7A" : "#E8A020" }}>{t.speaker}</p>
                  <div className={`px-2.5 py-1.5 rounded-xl text-[11px] leading-relaxed ${t.speaker === "Agent" ? "bg-white/8 text-white/80 rounded-tl-sm" : "bg-[#E8A020]/15 text-[#F5D080] rounded-tr-sm"}`}>
                    {t.text}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Result */}
        <div className="rounded-xl border border-[#2D9A62]/20 bg-[#2D9A62]/8 p-3 flex items-center gap-2.5 transition-all duration-500"
          style={{ opacity: step >= 6 ? 1 : 0, transform: step >= 6 ? "none" : "translateY(4px)" }}>
          <svg className="w-4 h-4 text-[#3DBA7A] flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7"/></svg>
          <p className="text-[11px] text-[#3DBA7A] font-semibold">Booking confirmed + confirmation SMS sent</p>
        </div>
      </div>
    </DemoShell>
  );
}

function LeadNurturingDemo() {
  const step = useLoop(5, 1000, 3000);
  const nodes = [
    { icon: "📥", label: "Lead captured", sublabel: "Via WhatsApp / Web form", color: "#60A5FA", at: 1 },
    { icon: "⏱️", label: "Instant follow-up sent", sublabel: "Within 2 minutes", color: "#3DBA7A", at: 2 },
    { icon: "🔁", label: "Reminder at 24h", sublabel: "If no response", color: "#E8A020", at: 3 },
    { icon: "📅", label: "Re-engagement at 7 days", sublabel: "Warm re-activation message", color: "#A78BFA", at: 4 },
    { icon: "✅", label: "Lead converted", sublabel: "Booked appointment", color: "#3DBA7A", at: 5 },
  ];

  return (
    <DemoShell label="Lead Nurturing">
      <div className="space-y-1.5">
        {nodes.map((node, i) => (
          <div key={i} className="flex items-start gap-3 transition-all duration-500"
            style={{ opacity: step >= node.at ? 1 : 0.25, transform: step >= node.at ? "none" : "translateX(-4px)" }}>
            {/* Left: dot + line */}
            <div className="flex flex-col items-center flex-shrink-0 mt-0.5">
              <div className="w-7 h-7 rounded-full flex items-center justify-center text-base transition-all duration-300"
                style={{ background: step >= node.at ? `${node.color}18` : "rgba(255,255,255,0.04)", border: `1.5px solid ${step >= node.at ? node.color : "rgba(255,255,255,0.1)"}` }}>
                {node.icon}
              </div>
              {i < nodes.length - 1 && (
                <div className="w-0.5 flex-1 mt-1 mb-0 h-4 transition-all duration-500 rounded-full"
                  style={{ background: step >= node.at + 1 ? node.color : "rgba(255,255,255,0.08)" }} />
              )}
            </div>
            {/* Content */}
            <div className="flex-1 pb-2">
              <p className="text-xs font-semibold text-white/90 leading-tight">{node.label}</p>
              <p className="text-[10px] text-white/40 mt-0.5">{node.sublabel}</p>
            </div>
            {/* Status dot */}
            <div className="flex-shrink-0 mt-1">
              {step >= node.at ? (
                <span className="w-1.5 h-1.5 rounded-full block animate-pulse" style={{ background: node.color }} />
              ) : (
                <span className="w-1.5 h-1.5 rounded-full block bg-white/10" />
              )}
            </div>
          </div>
        ))}
      </div>
    </DemoShell>
  );
}

function ReviewsDemo() {
  const step = useLoop(7, 750, 3200);
  const stars = [1, 2, 3, 4, 5];

  return (
    <DemoShell label="Reviews">
      <div className="space-y-3">
        {/* WhatsApp message */}
        <div className="rounded-xl border border-white/10 overflow-hidden bg-white shadow max-w-xs mx-auto">
          <div className="flex items-center gap-2 px-3 py-2 bg-[#2D9A62]">
            <div className="w-6 h-6 rounded-full bg-white/20 flex items-center justify-center text-xs">⭐</div>
            <p className="text-white text-[10px] font-semibold">KasiTek Reviews</p>
          </div>

          <div className="px-2.5 py-2.5 space-y-2" style={{ background: "#ece5dd" }}>
            {/* Review request */}
            <div className="flex justify-start transition-all duration-500" style={{ opacity: step >= 1 ? 1 : 0, transform: step >= 1 ? "none" : "translateY(4px)" }}>
              <div className="bg-white rounded-[0_12px_12px_12px] px-3 py-2 text-[11px] text-gray-800 shadow-sm max-w-[85%]">
                Hi Sipho 👋 How was your service today? Tap a star to rate us!
                <div className="flex gap-1 mt-2">
                  {stars.map((s) => (
                    <span key={s} className="text-lg transition-all duration-300"
                      style={{ opacity: step >= s + 1 ? 1 : 0.2, transform: step >= s + 1 ? "scale(1.15)" : "scale(1)", color: step >= s + 1 ? "#F59E0B" : "#D1D5DB", transitionDelay: `${s * 60}ms` }}>
                      ★
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Customer reply */}
            <div className="flex justify-end transition-all duration-500" style={{ opacity: step >= 7 ? 1 : 0, transform: step >= 7 ? "none" : "translateY(4px)" }}>
              <div className="px-3 py-1.5 text-[11px] rounded-[12px_0_12px_12px] shadow-sm" style={{ background: "#dcf8c6", color: "#1a1a1a" }}>
                Amazing service, 5 stars! 🌟
              </div>
            </div>
          </div>
        </div>

        {/* Google review notification */}
        <div className="rounded-xl border border-[#E8A020]/20 bg-[#E8A020]/8 p-3 flex items-center gap-2.5 transition-all duration-500"
          style={{ opacity: step >= 7 ? 1 : 0, transform: step >= 7 ? "none" : "translateY(4px)" }}>
          <div className="w-7 h-7 rounded-lg bg-white flex items-center justify-center flex-shrink-0 text-sm shadow-sm">G</div>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-semibold text-white/90 leading-tight">Google review routed</p>
            <p className="text-[10px] text-white/40">Sipho M. — 5 stars · just now</p>
          </div>
          <div className="flex gap-0.5 flex-shrink-0">
            {[1,2,3,4,5].map(i => <span key={i} className="text-[#F59E0B] text-xs">★</span>)}
          </div>
        </div>
      </div>
    </DemoShell>
  );
}

function ReportingDemo() {
  const step = useLoop(5, 700, 3200);
  const targets = [128, 91, 37, 4];
  const [counts, setCounts] = useState([0, 0, 0, 0]);

  useEffect(() => {
    if (step === 0) { setCounts([0, 0, 0, 0]); return; }
    const timers: ReturnType<typeof setInterval>[] = [];
    targets.forEach((target, i) => {
      if (step < i + 1) return;
      let cur = 0;
      const inc = target / 28;
      const t = setInterval(() => {
        cur = Math.min(cur + inc, target);
        setCounts(prev => { const n = [...prev]; n[i] = Math.floor(cur); return n; });
        if (cur >= target) clearInterval(t);
      }, 38);
      timers.push(t);
    });
    return () => timers.forEach(clearInterval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const metrics = [
    { label: "Qualified leads", suffix: "", color: "#E8A020", at: 1 },
    { label: "Reply rate", suffix: "%", color: "#3DBA7A", at: 2 },
    { label: "Appointments", suffix: "", color: "#60A5FA", at: 3 },
    { label: "Avg response", suffix: "s", color: "#A78BFA", at: 4 },
  ];

  const barData = [65, 80, 45, 92, 78, 88, 55];
  const days = ["M", "T", "W", "T", "F", "S", "S"];

  return (
    <DemoShell label="Reporting Dashboard">
      <div className="space-y-3">
        {/* Metric cards */}
        <div className="grid grid-cols-2 gap-2">
          {metrics.map((m, i) => (
            <div key={i} className="rounded-xl border border-white/8 bg-[#0D0D0D] p-3 transition-all duration-500"
              style={{ opacity: step >= m.at ? 1 : 0.3, transform: step >= m.at ? "none" : "translateY(4px)" }}>
              <p className="font-display text-3xl leading-none" style={{ color: m.color }}>{counts[i]}{m.suffix}</p>
              <p className="text-[10px] text-white/40 mt-1 uppercase tracking-wide leading-tight">{m.label}</p>
            </div>
          ))}
        </div>

        {/* Bar chart */}
        <div className="rounded-xl border border-white/8 bg-[#0D0D0D] p-3 transition-all duration-500"
          style={{ opacity: step >= 5 ? 1 : 0, transform: step >= 5 ? "none" : "translateY(4px)" }}>
          <p className="text-[10px] text-white/40 uppercase tracking-widest mb-2">Conversations this week</p>
          <div className="flex items-end gap-1.5 h-14">
            {barData.map((h, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-1">
                <div className="w-full rounded-sm transition-all duration-700 bg-[#E8A020]/70"
                  style={{ height: step >= 5 ? `${(h / 100) * 48}px` : "2px", transitionDelay: `${i * 60}ms` }} />
                <span className="text-[8px] text-white/30">{days[i]}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </DemoShell>
  );
}

function ContentEngineDemo() {
  const step = useLoop(6, 850, 3000);
  const fullText = "Boost your business this summer with our 15% off promotion on all electrical services. Limited time only — book now!";
  const displayText = fullText.slice(0, step >= 3 ? Math.min((step - 2) * 28, fullText.length) : 0);

  return (
    <DemoShell label="Content Engine">
      <div className="space-y-3">
        {/* Brief card */}
        <div className="rounded-xl border border-white/8 bg-[#0D0D0D] p-3 transition-all duration-500"
          style={{ opacity: step >= 1 ? 1 : 0, transform: step >= 1 ? "none" : "translateY(4px)" }}>
          <p className="text-[10px] text-[#E8A020] font-semibold uppercase tracking-widest mb-1.5">Campaign Brief</p>
          <div className="space-y-1">
            {["Offer: 15% off summer promo", "Audience: Existing customers", "Channels: WhatsApp, Instagram"].map((line, i) => (
              <p key={i} className="text-[11px] text-white/60 flex items-center gap-1.5">
                <span className="w-1 h-1 rounded-full bg-[#E8A020]/50 flex-shrink-0" />
                {line}
              </p>
            ))}
          </div>
        </div>

        {/* AI generating */}
        <div className="rounded-xl border border-white/8 bg-[#0D0D0D] p-3 transition-all duration-500"
          style={{ opacity: step >= 2 ? 1 : 0 }}>
          <div className="flex items-center gap-1.5 mb-2">
            <div className="w-3 h-3 rounded-sm bg-[#E8A020]/20 flex items-center justify-center">
              <Sparkles className="w-2 h-2 text-[#E8A020]" />
            </div>
            <p className="text-[10px] text-[#E8A020]/70 font-semibold">AI writing copy…</p>
            {step <= 4 && <span className="inline-block w-1 h-3 bg-[#E8A020] animate-pulse rounded-sm ml-0.5" />}
          </div>
          <p className="text-[11px] text-white/80 leading-relaxed min-h-[3rem]">{displayText}</p>
        </div>

        {/* Output channels */}
        <div className="grid grid-cols-2 gap-2 transition-all duration-500"
          style={{ opacity: step >= 5 ? 1 : 0, transform: step >= 5 ? "none" : "translateY(4px)" }}>
          {[
            { label: "WhatsApp blast", icon: "💬", color: "#3DBA7A" },
            { label: "Instagram post", icon: "📸", color: "#A78BFA" },
            { label: "Facebook ad", icon: "📢", color: "#60A5FA" },
            { label: "Email campaign", icon: "📧", color: "#E8A020" },
          ].map((c, i) => (
            <div key={i} className="rounded-xl border border-white/8 bg-white/[0.03] p-2.5 flex items-center gap-2 transition-all duration-500"
              style={{ transitionDelay: `${i * 80}ms`, opacity: step >= 5 ? 1 : 0 }}>
              <span className="text-sm">{c.icon}</span>
              <p className="text-[10px] font-semibold" style={{ color: c.color }}>{c.label}</p>
            </div>
          ))}
        </div>
      </div>
    </DemoShell>
  );
}

function AEODemo() {
  const step = useLoop(5, 900, 3200);
  const query = "best electrical contractor Johannesburg";
  const answerLines = [
    "KasiTek-powered contractors offer same-day electrical inspections across Johannesburg.",
    "Services include DB board upgrades, emergency callouts, and solar installations.",
    "Book directly via WhatsApp — no forms, instant confirmation.",
  ];

  return (
    <DemoShell label="AI Content Optimisation">
      <div className="space-y-3">
        {/* Search bar */}
        <div className="rounded-xl border border-white/10 bg-[#0D0D0D] p-2.5 flex items-center gap-2 transition-all duration-500"
          style={{ opacity: step >= 1 ? 1 : 0 }}>
          <svg className="w-3.5 h-3.5 text-white/30 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
          <p className="text-[11px] text-white/60">{step >= 1 ? query : ""}</p>
        </div>

        {/* AI answer box */}
        <div className="rounded-xl border border-[#E8A020]/20 bg-[#E8A020]/5 p-3 transition-all duration-500"
          style={{ opacity: step >= 2 ? 1 : 0, transform: step >= 2 ? "none" : "translateY(4px)" }}>
          <div className="flex items-center gap-1.5 mb-2">
            <div className="w-4 h-4 rounded-sm bg-[#E8A020]/20 flex items-center justify-center">
              <Sparkles className="w-2.5 h-2.5 text-[#E8A020]" />
            </div>
            <p className="text-[10px] text-[#E8A020] font-semibold">AI Overview</p>
          </div>
          <div className="space-y-1.5">
            {answerLines.map((line, i) => (
              <p key={i} className="text-[11px] text-white/70 leading-relaxed transition-all duration-500"
                style={{ opacity: step >= i + 2 ? 1 : 0, transform: step >= i + 2 ? "none" : "translateY(3px)", transitionDelay: `${i * 120}ms` }}>
                {i === 0 ? "→ " : i === 1 ? "· " : "✓ "}{line}
              </p>
            ))}
          </div>
        </div>

        {/* Citation */}
        <div className="rounded-xl border border-white/8 bg-[#0D0D0D] p-2.5 flex items-center gap-2 transition-all duration-500"
          style={{ opacity: step >= 5 ? 1 : 0, transform: step >= 5 ? "none" : "translateY(4px)" }}>
          <div className="w-6 h-6 rounded-md bg-[#3DBA7A]/10 border border-[#3DBA7A]/20 flex items-center justify-center flex-shrink-0">
            <svg className="w-3 h-3 text-[#3DBA7A]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-semibold text-white/80 truncate">yoursite.co.za — cited as an AI source</p>
            <p className="text-[9px] text-white/30">Structured content matched the AI query</p>
          </div>
          <span className="text-[9px] text-[#3DBA7A] font-semibold flex-shrink-0">Indexed</span>
        </div>
      </div>
    </DemoShell>
  );
}

function PlatformEmbedDemo() {
  const step = useLoop(6, 800, 3000);

  return (
    <DemoShell label="Platform Embed">
      <div className="space-y-3">
        {/* API request */}
        <div className="rounded-xl border border-white/8 bg-[#0A0A0A] p-3 font-mono transition-all duration-500"
          style={{ opacity: step >= 1 ? 1 : 0 }}>
          <p className="text-[9px] text-white/30 mb-1.5 font-sans uppercase tracking-widest">API Request</p>
          <div className="space-y-0.5">
            <p className="text-[10px]"><span className="text-[#60A5FA]">POST</span> <span className="text-white/60">/v1/embed/widget</span></p>
            <p className="text-[10px] text-white/40">tenant_id: <span className="text-[#3DBA7A]">&quot;alpha-biz&quot;</span></p>
            <p className="text-[10px] text-white/40">brand: <span className="text-[#E8A020]">&quot;custom&quot;</span></p>
          </div>
        </div>

        {/* Processing */}
        <div className="flex items-center gap-2 transition-all duration-400" style={{ opacity: step >= 2 ? 1 : 0 }}>
          <div className="flex-1 h-px bg-gradient-to-r from-[#60A5FA]/30 to-transparent" />
          <div className="flex gap-1 items-center">
            {[0,1,2].map(i => (
              <div key={i} className="w-1.5 h-1.5 rounded-full bg-[#60A5FA]"
                style={{ opacity: step >= 2 ? 1 : 0, animation: step >= 2 && step <= 3 ? "pulse 1s ease infinite" : "none", animationDelay: `${i*0.2}s` }} />
            ))}
          </div>
          <div className="flex-1 h-px bg-gradient-to-l from-[#60A5FA]/30 to-transparent" />
        </div>

        {/* Embed ready */}
        <div className="rounded-xl border border-[#60A5FA]/20 bg-[#60A5FA]/5 p-3 transition-all duration-500"
          style={{ opacity: step >= 3 ? 1 : 0, transform: step >= 3 ? "none" : "translateY(4px)" }}>
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] text-[#60A5FA] font-semibold uppercase tracking-widest">Widget Deployed</p>
            <span className="text-[9px] bg-[#3DBA7A]/15 text-[#3DBA7A] px-1.5 py-0.5 rounded-full border border-[#3DBA7A]/20">Live</span>
          </div>
          <div className="space-y-1">
            {["Conversation agent active", "Brand config applied", "Analytics connected"].map((line, i) => (
              <div key={i} className="flex items-center gap-2 transition-all duration-500"
                style={{ opacity: step >= i + 3 ? 1 : 0, transitionDelay: `${i * 150}ms` }}>
                <svg className="w-3 h-3 text-[#3DBA7A] flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7"/></svg>
                <p className="text-[11px] text-white/70">{line}</p>
              </div>
            ))}
          </div>
        </div>

        {/* First customer interaction */}
        <div className="rounded-xl border border-white/8 bg-[#0D0D0D] p-3 transition-all duration-500"
          style={{ opacity: step >= 6 ? 1 : 0, transform: step >= 6 ? "none" : "translateY(4px)" }}>
          <p className="text-[9px] text-white/30 uppercase tracking-widest mb-1.5">First interaction · just now</p>
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-[#60A5FA]/10 border border-[#60A5FA]/20 flex items-center justify-center text-[10px] text-[#60A5FA] font-bold">A</div>
            <p className="text-[11px] text-white/70">&quot;How does the pricing work?&quot;</p>
          </div>
        </div>
      </div>
    </DemoShell>
  );
}

function TenantProvisioningDemo() {
  const step = useLoop(6, 750, 3000);
  const tasks = [
    { label: "Tenant workspace created", at: 1, color: "#3DBA7A" },
    { label: "Brand config applied", at: 2, color: "#3DBA7A" },
    { label: "WhatsApp number connected", at: 3, color: "#3DBA7A" },
    { label: "AI agent trained on business data", at: 4, color: "#E8A020" },
    { label: "Website widget deployed", at: 5, color: "#60A5FA" },
    { label: "Client dashboard access granted", at: 6, color: "#A78BFA" },
  ];

  return (
    <DemoShell label="Client Provisioning">
      <div className="space-y-2.5">
        <div className="flex items-center justify-between mb-1">
          <p className="text-[10px] text-white/40 uppercase tracking-widest">Setup checklist</p>
          <p className="text-[10px] font-bold" style={{ color: "#3DBA7A" }}>{step}/6 complete</p>
        </div>

        {tasks.map((task, i) => (
          <div key={i} className="flex items-center gap-3 rounded-xl p-2.5 transition-all duration-500"
            style={{
              background: step >= task.at ? `${task.color}0D` : "rgba(255,255,255,0.02)",
              border: `1px solid ${step >= task.at ? task.color + "30" : "rgba(255,255,255,0.06)"}`,
            }}>
            {/* Checkbox */}
            <div className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 transition-all duration-500"
              style={{
                background: step >= task.at ? task.color : "rgba(255,255,255,0.06)",
                border: `1.5px solid ${step >= task.at ? task.color : "rgba(255,255,255,0.12)"}`,
              }}>
              {step >= task.at ? (
                <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7"/></svg>
              ) : step === task.at - 1 ? (
                <div className="w-2 h-2 rounded-full border-2 border-white/30 border-t-white/80 animate-spin" />
              ) : null}
            </div>
            <p className="text-[11px] transition-colors duration-500" style={{ color: step >= task.at ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.3)" }}>
              {task.label}
            </p>
          </div>
        ))}

        {/* Progress bar */}
        <div className="rounded-full h-1.5 bg-white/8 overflow-hidden mt-1">
          <div className="h-full rounded-full bg-gradient-to-r from-[#3DBA7A] to-[#60A5FA] transition-all duration-700"
            style={{ width: `${(step / 6) * 100}%` }} />
        </div>
      </div>
    </DemoShell>
  );
}

function UsageReportingDemo() {
  const step = useLoop(5, 800, 3000);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(v => v + 1), 1800);
    return () => clearInterval(t);
  }, []);

  const metrics = [
    { label: "API calls today", value: 4821 + tick * 3, suffix: "", color: "#60A5FA", at: 1 },
    { label: "Avg latency", value: 380 - tick * 2, suffix: "ms", color: "#3DBA7A", at: 2 },
    { label: "Active tenants", value: 47, suffix: "", color: "#E8A020", at: 3 },
    { label: "Error rate", value: 0.3, suffix: "%", color: "#A78BFA", at: 4 },
  ];

  return (
    <DemoShell label="Usage Reporting" badge="Live Data">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          {metrics.map((m, i) => (
            <div key={i} className="rounded-xl border border-white/8 bg-[#0D0D0D] p-3 transition-all duration-500"
              style={{ opacity: step >= m.at ? 1 : 0.2, transform: step >= m.at ? "none" : "translateY(4px)" }}>
              <p className="font-display text-2xl leading-none" style={{ color: m.color }}>
                {typeof m.value === "number" && m.value > 100 ? m.value.toLocaleString() : m.value}{m.suffix}
              </p>
              <p className="text-[9px] text-white/35 mt-1 uppercase tracking-wide leading-tight">{m.label}</p>
            </div>
          ))}
        </div>

        {/* Live feed */}
        <div className="rounded-xl border border-white/8 bg-[#0D0D0D] p-3 transition-all duration-500"
          style={{ opacity: step >= 5 ? 1 : 0 }}>
          <p className="text-[9px] text-white/30 uppercase tracking-widest mb-2">Event stream · live</p>
          {[
            { tenant: "alpha-biz", event: "conversation started", t: "just now", color: "#3DBA7A" },
            { tenant: "soweto-hw", event: "quote generated", t: "2s ago", color: "#E8A020" },
            { tenant: "city-clinic", event: "booking confirmed", t: "5s ago", color: "#60A5FA" },
          ].map((ev, i) => (
            <div key={i} className="flex items-center gap-2 py-1 border-b border-white/5 last:border-0">
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: ev.color }} />
              <span className="text-[10px] font-semibold text-white/60 flex-shrink-0">{ev.tenant}</span>
              <span className="text-[10px] text-white/35 truncate flex-1">{ev.event}</span>
              <span className="text-[9px] text-white/20 flex-shrink-0">{ev.t}</span>
            </div>
          ))}
        </div>
      </div>
    </DemoShell>
  );
}

function ComingSoonDemo() {
  return (
    <DemoShell label="Coming Soon" badge="In development">
      <div className="flex flex-col items-center justify-center py-12 gap-4">
        <div className="w-12 h-12 rounded-2xl border border-[#E8A020]/20 bg-[#E8A020]/8 flex items-center justify-center">
          <Sparkles className="w-5 h-5 text-[#E8A020]" />
        </div>
        <div className="text-center">
          <p className="font-display text-2xl text-foreground mb-2">Coming Soon</p>
          <p className="text-sm text-muted-foreground max-w-xs leading-relaxed">This demo is still being built. The live experience will land here once ready.</p>
        </div>
      </div>
    </DemoShell>
  );
}

// ── Router ───────────────────────────────────────────────────────────────────
function renderDemo(kind: SolutionDemoKind) {
  switch (kind) {
    case "website-agent": return <WebsiteAgentDemo />;
    case "whatsapp-agent": return <WhatsAppAgentDemo />;
    case "catalogue-agent": return <CatalogueAgentDemo />;
    case "quote-automation": return <QuoteDemo />;
    case "voice-agent": return <VoiceDemo />;
    case "lead-nurturing": return <LeadNurturingDemo />;
    case "reviews": return <ReviewsDemo />;
    case "reporting": return <ReportingDemo />;
    case "content-engine": return <ContentEngineDemo />;
    case "aeo": return <AEODemo />;
    case "platform-embed": return <PlatformEmbedDemo />;
    case "usage-reporting": return <UsageReportingDemo />;
    case "tenant-provisioning": return <TenantProvisioningDemo />;
    default: return <ComingSoonDemo />;
  }
}

// ── Main export ──────────────────────────────────────────────────────────────
export function SolutionServicesShowcase({
  eyebrow,
  title,
  description,
  services,
}: {
  eyebrow: string;
  title: string;
  description: string;
  services: SolutionService[];
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const activeService = services[activeIndex];

  return (
    <section className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      {/* Left: service list */}
      <div className="rounded-2xl border border-white/8 bg-[#0D0D0D] p-6 md:p-7">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-primary">{eyebrow}</p>
        <h2 className="font-display text-3xl leading-none text-foreground md:text-4xl mb-3">{title}</h2>
        <p className="text-sm leading-relaxed text-muted-foreground mb-7">{description}</p>

        <div className="space-y-2.5">
          {services.map((service, index) => {
            const active = index === activeIndex;
            return (
              <button
                key={service.title}
                type="button"
                onClick={() => setActiveIndex(index)}
                className={`w-full rounded-2xl border px-4 py-3.5 text-left transition-all duration-200 ${
                  active
                    ? "border-primary/30 bg-primary/10"
                    : "border-white/8 bg-white/[0.03] hover:border-white/14 hover:bg-white/[0.05]"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-foreground leading-tight">{service.title}</p>
                    <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{service.description}</p>
                  </div>
                  {active && (
                    <span className="shrink-0 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-primary whitespace-nowrap">
                      Live
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Right: animated demo */}
      <div className="rounded-2xl border border-white/8 bg-[#0D0D0D] p-5 md:p-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground mb-2">Live Demo</p>
            <h3 className="font-display text-2xl leading-none text-foreground md:text-3xl">{activeService.title}</h3>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground max-w-sm">{activeService.description}</p>
          </div>
        </div>

        {renderDemo(activeService.demoKind)}
      </div>
    </section>
  );
}
