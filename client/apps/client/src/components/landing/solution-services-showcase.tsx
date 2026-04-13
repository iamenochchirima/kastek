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

// ─────────────────────────────────────────────────────────────────────────────
// SHARED: Scenario sequencer hook
// ─────────────────────────────────────────────────────────────────────────────
function useScenarioSequence(totalScenarios: number, stepsPerScenario: number[], stepMs = 950, holdMs = 2400, fadeMs = 420) {
  const [scenarioIdx, setScenarioIdx] = useState(0);
  const [msgStep, setMsgStep] = useState(0);
  const [fading, setFading] = useState(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    setMsgStep(0);
    setFading(false);

    const stepCount = stepsPerScenario[scenarioIdx] ?? 4;
    for (let i = 1; i <= stepCount; i++) {
      const t = setTimeout(() => setMsgStep(i), i * stepMs);
      timersRef.current.push(t);
    }
    const total = stepCount * stepMs + holdMs;
    const t1 = setTimeout(() => {
      setFading(true);
      const t2 = setTimeout(() => {
        setScenarioIdx(prev => (prev + 1) % totalScenarios);
      }, fadeMs);
      timersRef.current.push(t2);
    }, total);
    timersRef.current.push(t1);

    return () => { timersRef.current.forEach(clearTimeout); timersRef.current = []; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarioIdx]);

  return { scenarioIdx, msgStep, fading };
}

// ─────────────────────────────────────────────────────────────────────────────
// WHATSAPP AGENT — 4 sequential scenarios
// ─────────────────────────────────────────────────────────────────────────────
type WaStep =
  | { kind: "out"; text: string }
  | { kind: "in"; text: string }
  | { kind: "booking"; service: string; time: string; address: string }
  | { kind: "quote"; items: { label: string; amount: string }[]; total: string }
  | { kind: "products"; items: { name: string; price: string; emoji: string }[] };

const WA_SCENARIOS: { title: string; subtitle: string; accent: string; emoji: string; agentName: string; steps: WaStep[] }[] = [
  {
    title: "AI Assistant", subtitle: "Instant answers, 24/7",
    accent: "#3DBA7A", emoji: "🤖", agentName: "KasiTek AI",
    steps: [
      { kind: "out", text: "Hi, what time do you close on Saturdays?" },
      { kind: "in", text: "Hey! 👋 We're open Sat 8am–1pm. Anything I can help with?" },
      { kind: "out", text: "Do you guys service Pretoria East?" },
      { kind: "in", text: "Yes, we cover all of Tshwane & surrounds. Want me to book a technician for you?" },
    ],
  },
  {
    title: "Appointment Booking", subtitle: "Zero-friction bookings in chat",
    accent: "#60A5FA", emoji: "📅", agentName: "KasiTek Booking",
    steps: [
      { kind: "out", text: "I need a plumber — is Friday morning free?" },
      { kind: "in", text: "Friday is open ✅ — 9am or 11am, which suits you better?" },
      { kind: "out", text: "9am please. Address is 14 Elm Street, Soweto" },
      { kind: "in", text: "Got it — booking you in now 📲" },
      { kind: "booking", service: "Plumbing Inspection", time: "Friday · 09:00", address: "14 Elm St, Soweto" },
    ],
  },
  {
    title: "Quote Generation", subtitle: "Instant quotes inside WhatsApp",
    accent: "#E8A020", emoji: "🧾", agentName: "KasiTek Quotes",
    steps: [
      { kind: "out", text: "Can I get a price on upgrading my DB board to 16 circuits?" },
      { kind: "in", text: "Sure thing! Let me pull that together for you 🔧" },
      { kind: "quote", items: [{ label: "DB Board 16-way", amount: "R 2,800" }, { label: "Labour & installation", amount: "R 1,600" }, { label: "Certificate of compliance", amount: "R 450" }], total: "R 4,850" },
      { kind: "in", text: "There's your quote — valid 7 days. Reply ACCEPT to confirm 👍" },
    ],
  },
  {
    title: "Product Catalogue", subtitle: "Browse & order conversationally",
    accent: "#A78BFA", emoji: "🛍️", agentName: "KasiTek Shop",
    steps: [
      { kind: "out", text: "What solar backup options do you have under R15k?" },
      { kind: "in", text: "We've got 3 packages in that range — here they are 👇" },
      { kind: "products", items: [{ name: "5kWh LiFePO4 Pack", price: "R 8,990", emoji: "🔋" }, { name: "8kWh Premium Pack", price: "R 12,500", emoji: "⚡" }, { name: "3kWh Starter Kit", price: "R 5,800", emoji: "🔌" }] },
    ],
  },
];

const WA_CHAT_BG = `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23d4c9ba' fill-opacity='0.4'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`;

const MSG_TIMES = ["08:42", "08:43", "08:43", "08:44", "08:44", "08:45", "08:45"];

function WhatsAppAgentDemo() {
  const stepCounts = WA_SCENARIOS.map(s => s.steps.length);
  const { scenarioIdx, msgStep, fading } = useScenarioSequence(WA_SCENARIOS.length, stepCounts, 1400, 3500, 500);
  const scenario = WA_SCENARIOS[scenarioIdx];
  const nextStep = scenario.steps[msgStep];
  const showTyping = msgStep < scenario.steps.length && nextStep?.kind === "in";

  return (
    <div className="space-y-3">
      {/* Scenario indicator */}
      <div className="rounded-2xl border border-white/8 bg-[#0D0D0D] px-4 py-3 flex items-center gap-3">
        <div className="flex gap-1.5">
          {WA_SCENARIOS.map((s, i) => (
            <div key={i} className="h-1.5 rounded-full transition-all duration-500"
              style={{ width: i === scenarioIdx ? 20 : 6, background: i === scenarioIdx ? s.accent : "rgba(255,255,255,0.15)" }} />
          ))}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-semibold truncate leading-tight" style={{ color: scenario.accent }}>{scenario.title}</p>
          <p className="text-[9px] text-white/35 truncate leading-tight">{scenario.subtitle}</p>
        </div>
        <span className="text-[9px] text-white/30 font-semibold flex-shrink-0">{scenarioIdx + 1}/{WA_SCENARIOS.length}</span>
      </div>

      {/* Phone frame — same structure as solutions-v2/WhatsAppMockup */}
      <div className="relative mx-auto transition-opacity duration-[420ms]" style={{ width: 300, opacity: fading ? 0 : 1 }}>
        {/* Device shell */}
        <div style={{ background: "#1c1c1e", borderRadius: 44, padding: 10, boxShadow: "0 30px 80px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.07)" }}>
          {/* Screen */}
          <div style={{ borderRadius: 34, overflow: "hidden" }}>

            {/* Status bar (sits inside green header) */}
            <div style={{ background: "#2D9A62", padding: "5px 16px 3px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: "white", letterSpacing: 0.3 }}>08:45</span>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <svg style={{ width: 13, height: 10, fill: "white" }} viewBox="0 0 20 14">
                  <rect x="0" y="8" width="3" height="6" rx="1"/><rect x="4.5" y="5" width="3" height="9" rx="1"/>
                  <rect x="9" y="2.5" width="3" height="11.5" rx="1"/><rect x="13.5" y="0" width="3" height="14" rx="1"/>
                </svg>
                <svg style={{ width: 13, height: 10, fill: "white" }} viewBox="0 0 22 16">
                  <path d="M11 11a2.5 2.5 0 110 5 2.5 2.5 0 010-5zm0-5c2.76 0 5.24 1.12 7.05 2.93L16.3 10.7A7.47 7.47 0 0011 8.5c-2.07 0-3.94.84-5.3 2.2L3.95 8.93A10.47 10.47 0 0111 6zm0-6C15.97 0 20.45 2.07 23.6 5.42L21.84 7.2A14.96 14.96 0 0011 2.5 14.96 14.96 0 00.16 7.2L-1.6 5.42A17.47 17.47 0 0111 0z"/>
                </svg>
                <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                  <div style={{ width: 19, height: 10, border: "1.5px solid rgba(255,255,255,0.9)", borderRadius: 3, padding: "1.5px 2px", boxSizing: "border-box" }}>
                    <div style={{ width: "78%", height: "100%", background: "white", borderRadius: 1 }} />
                  </div>
                  <div style={{ width: 2, height: 6, background: "rgba(255,255,255,0.7)", borderRadius: "0 1px 1px 0" }} />
                </div>
              </div>
            </div>

            {/* WA header */}
            <div style={{ background: "#2D9A62", padding: "8px 12px 10px", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid rgba(0,0,0,0.08)" }}>
              <div style={{ width: 36, height: 36, borderRadius: "50%", background: "rgba(255,255,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>{scenario.emoji}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ color: "white", fontSize: 13, fontWeight: 600, margin: 0, lineHeight: 1.25 }}>{scenario.agentName}</p>
                <p style={{ color: "#b5e7cc", fontSize: 10, margin: 0, lineHeight: 1.4 }}>Typically replies instantly</p>
              </div>
              <svg style={{ width: 20, height: 20, fill: "none", stroke: "rgba(255,255,255,0.8)", strokeWidth: 2 }} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 7V5z"/>
              </svg>
            </div>

            {/* Chat area with WhatsApp wallpaper */}
            <div style={{ background: "#eae6df", backgroundImage: WA_CHAT_BG, padding: "10px 10px 6px", minHeight: 390, maxHeight: 390, overflow: "hidden", display: "flex", flexDirection: "column", gap: 5 }}>
              {scenario.steps.map((s, i) => {
                const visible = msgStep > i;
                const t = MSG_TIMES[i] ?? "08:45";

                if (s.kind === "out") return (
                  <div key={i} style={{ display: "flex", justifyContent: "flex-end", opacity: visible ? 1 : 0, transform: visible ? "none" : "translateY(6px)", transition: "all 0.45s ease" }}>
                    <div style={{ maxWidth: "82%" }}>
                      <div style={{ background: "#dcf8c6", borderRadius: "12px 0 12px 12px", padding: "7px 11px 5px", fontSize: 13, lineHeight: 1.55, color: "#111", boxShadow: "0 1px 2px rgba(0,0,0,0.1)" }}>{s.text}</div>
                      <p style={{ fontSize: 10, color: "#8e9297", margin: "2px 0 0", textAlign: "right" }}>{t} <span style={{ color: "#4fc3f7" }}>✓✓</span></p>
                    </div>
                  </div>
                );

                if (s.kind === "in") return (
                  <div key={i} style={{ display: "flex", justifyContent: "flex-start", opacity: visible ? 1 : 0, transform: visible ? "none" : "translateY(6px)", transition: "all 0.45s ease" }}>
                    <div style={{ maxWidth: "82%" }}>
                      <div style={{ background: "#fff", borderRadius: "0 12px 12px 12px", padding: "7px 11px 5px", fontSize: 13, lineHeight: 1.55, color: "#111", boxShadow: "0 1px 2px rgba(0,0,0,0.1)" }}>{s.text}</div>
                      <p style={{ fontSize: 10, color: "#8e9297", margin: "2px 0 0" }}>{t}</p>
                    </div>
                  </div>
                );

                if (s.kind === "booking") return (
                  <div key={i} style={{ display: "flex", justifyContent: "flex-start", opacity: visible ? 1 : 0, transform: visible ? "none" : "translateY(6px)", transition: "all 0.45s ease" }}>
                    <div style={{ maxWidth: "90%", background: "#fff", borderRadius: "0 12px 12px 12px", overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.15)" }}>
                      <div style={{ background: scenario.accent, padding: "6px 10px", display: "flex", alignItems: "center", gap: 6 }}>
                        <svg style={{ width: 12, height: 12, fill: "none", stroke: "white", strokeWidth: 2, flexShrink: 0 }} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                        <span style={{ color: "white", fontSize: 10, fontWeight: 600 }}>Appointment Confirmed</span>
                      </div>
                      <div style={{ padding: "7px 10px" }}>
                        <p style={{ fontSize: 12, fontWeight: 600, color: "#111", margin: 0 }}>{s.time}</p>
                        <p style={{ fontSize: 10, color: "#666", margin: "2px 0 0" }}>{s.service} · {s.address}</p>
                      </div>
                    </div>
                  </div>
                );

                if (s.kind === "quote") return (
                  <div key={i} style={{ display: "flex", justifyContent: "flex-start", opacity: visible ? 1 : 0, transform: visible ? "none" : "translateY(6px)", transition: "all 0.45s ease" }}>
                    <div style={{ maxWidth: "92%", background: "#fff", borderRadius: "0 12px 12px 12px", overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.15)" }}>
                      <div style={{ background: scenario.accent, padding: "6px 10px" }}>
                        <span style={{ color: "white", fontSize: 10, fontWeight: 600 }}>Quotation Ready</span>
                      </div>
                      <div style={{ padding: "7px 10px" }}>
                        {s.items.map((it, j) => (
                          <div key={j} style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                            <span style={{ fontSize: 10, color: "#555" }}>{it.label}</span>
                            <span style={{ fontSize: 10, fontWeight: 600, color: "#111" }}>{it.amount}</span>
                          </div>
                        ))}
                        <div style={{ borderTop: "1px solid #eee", paddingTop: 4, marginTop: 2, display: "flex", justifyContent: "space-between" }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: "#111" }}>Total</span>
                          <span style={{ fontSize: 11, fontWeight: 700, color: scenario.accent }}>{s.total}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                );

                if (s.kind === "products") return (
                  <div key={i} style={{ opacity: visible ? 1 : 0, transition: "opacity 0.45s ease" }}>
                    {s.items.map((p, j) => (
                      <div key={j} style={{ display: "flex", alignItems: "center", gap: 8, background: "#fff", borderRadius: j === 0 ? "0 12px 6px 6px" : j === s.items.length - 1 ? "6px 6px 12px 12px" : 6, padding: "6px 8px", marginBottom: 3, boxShadow: "0 1px 2px rgba(0,0,0,0.1)", opacity: visible ? 1 : 0, transition: `opacity 0.4s ${j * 120}ms ease` }}>
                        <span style={{ fontSize: 18 }}>{p.emoji}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ fontSize: 11, fontWeight: 600, color: "#111", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</p>
                          <p style={{ fontSize: 10, fontWeight: 700, color: scenario.accent, margin: 0 }}>{p.price}</p>
                        </div>
                        <button style={{ fontSize: 9, border: `1px solid ${scenario.accent}`, color: scenario.accent, padding: "2px 6px", borderRadius: 4, background: "transparent", cursor: "default", flexShrink: 0 }}>Quote</button>
                      </div>
                    ))}
                  </div>
                );
                return null;
              })}

              {/* Typing dots */}
              <div style={{ display: "flex", justifyContent: "flex-start", opacity: showTyping ? 1 : 0, transition: "opacity 0.3s" }}>
                <div style={{ background: "#fff", borderRadius: "0 12px 12px 12px", padding: "8px 12px", display: "flex", gap: 4, boxShadow: "0 1px 2px rgba(0,0,0,0.1)" }}>
                  {[0,1,2].map(i => <span key={i} style={{ width: 7, height: 7, borderRadius: "50%", background: "#aaa", display: "inline-block", animation: `bounce 1s ease infinite ${i*0.15}s` }} />)}
                </div>
              </div>
            </div>

            {/* Input bar */}
            <div style={{ background: "#f0f0f0", padding: "8px 10px", display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ flex: 1, background: "white", borderRadius: 20, padding: "7px 14px", fontSize: 11, color: "#bbb", boxShadow: "0 1px 2px rgba(0,0,0,0.08)" }}>Message...</div>
              <div style={{ width: 34, height: 34, borderRadius: "50%", background: "#2D9A62", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: "0 2px 8px rgba(45,154,98,0.4)" }}>
                <svg style={{ width: 16, height: 16, fill: "none", stroke: "white", strokeWidth: 2.5 }} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/>
                </svg>
              </div>
            </div>
          </div>
        </div>
        {/* Notch — offset by shell padding (10px) so it sits on the screen, not the bezel */}
        <div style={{ position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)", width: 76, height: 20, background: "#1c1c1e", borderRadius: "0 0 14px 14px", zIndex: 10 }} />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// WEBSITE AGENT — 3 desktop widget scenarios
// ─────────────────────────────────────────────────────────────────────────────
type WebStep =
  | { kind: "agent"; text: string }
  | { kind: "user"; text: string }
  | { kind: "quick-replies"; options: string[]; selected?: number }
  | { kind: "form"; fields: { label: string; value: string }[]; submit: string }
  | { kind: "success"; text: string };

const WEB_SCENARIOS: { title: string; subtitle: string; accent: string; steps: WebStep[] }[] = [
  {
    title: "Lead Capture", subtitle: "Converting visitors into leads",
    accent: "#3DBA7A",
    steps: [
      { kind: "agent", text: "Welcome to KasiTek! How can I help you today? 👋" },
      { kind: "quick-replies", options: ["Request a Quote", "Book a Service", "Ask a Question"], selected: 0 },
      { kind: "user", text: "Request a Quote" },
      { kind: "agent", text: "Great! What service do you need quoted?" },
      { kind: "user", text: "Electrical inspection, Sandton" },
      { kind: "agent", text: "Got it! Our team will call you within the hour." },
      { kind: "success", text: "Lead captured — sales team notified ✓" },
    ],
  },
  {
    title: "Support & FAQ", subtitle: "Instant answers to common questions",
    accent: "#60A5FA",
    steps: [
      { kind: "agent", text: "Hi! Any questions? I can help right now." },
      { kind: "user", text: "Do you offer same-day electrical repairs?" },
      { kind: "agent", text: "Yes! Emergencies dispatched within 2 hours. Same-day slots open until noon." },
      { kind: "user", text: "What does a basic inspection cost?" },
      { kind: "agent", text: "Inspections start at R650 incl. callout fee. Want to book?" },
      { kind: "quick-replies", options: ["Book Now", "Get Full Quote"] },
    ],
  },
  {
    title: "Instant Booking", subtitle: "Book directly through the widget",
    accent: "#E8A020",
    steps: [
      { kind: "agent", text: "I can book a service for you right now 📅" },
      { kind: "form", fields: [{ label: "Service", value: "Electrical" }, { label: "Date", value: "Tomorrow" }, { label: "Time", value: "09:00" }], submit: "Confirm Booking →" },
      { kind: "success", text: "Booking confirmed for Tomorrow at 9am ✓" },
    ],
  },
];

function WebsiteAgentDemo() {
  const stepCounts = WEB_SCENARIOS.map(s => s.steps.length);
  const { scenarioIdx, msgStep, fading } = useScenarioSequence(WEB_SCENARIOS.length, stepCounts, 1300, 3200, 450);
  const scenario = WEB_SCENARIOS[scenarioIdx];
  const nextStep = scenario.steps[msgStep];
  const showTyping = msgStep < scenario.steps.length && nextStep?.kind === "agent";

  return (
    <div className="space-y-3">
      {/* Scenario indicator */}
      <div className="rounded-2xl border border-white/8 bg-[#0D0D0D] px-4 py-3 flex items-center gap-3">
        <div className="flex gap-1.5">
          {WEB_SCENARIOS.map((s, i) => (
            <div key={i} className="h-1.5 rounded-full transition-all duration-500"
              style={{ width: i === scenarioIdx ? 20 : 6, background: i === scenarioIdx ? s.accent : "rgba(255,255,255,0.15)" }} />
          ))}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-semibold truncate leading-tight" style={{ color: scenario.accent }}>{scenario.title}</p>
          <p className="text-[9px] text-white/35 truncate leading-tight">{scenario.subtitle}</p>
        </div>
        <span className="text-[9px] text-white/30 font-semibold flex-shrink-0">{scenarioIdx + 1}/{WEB_SCENARIOS.length}</span>
      </div>

      {/* Browser window */}
      <div className="rounded-xl overflow-hidden shadow-2xl transition-opacity duration-[450ms]"
        style={{ opacity: fading ? 0 : 1, border: "1px solid #D1D5DB" }}>

        {/* Browser chrome — light macOS style */}
        <div style={{ background: "#EBEBEB", padding: "8px 12px", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid #D1D5DB" }}>
          <div style={{ display: "flex", gap: 6 }}>
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#FF5F57" }} />
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#FEBC2E" }} />
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#28C840" }} />
          </div>
          <div style={{ flex: 1, background: "white", borderRadius: 6, padding: "4px 10px", display: "flex", alignItems: "center", gap: 6, boxShadow: "0 1px 2px rgba(0,0,0,0.08)" }}>
            <svg style={{ width: 10, height: 10, color: "#3DBA7A", fill: "currentColor", flexShrink: 0 }} viewBox="0 0 24 24"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>
            <span style={{ fontSize: 10, color: "#6B7280" }}>kasitek.co.za/services</span>
          </div>
        </div>

        {/* Page body — white light website */}
        <div style={{ background: "#F9FAFB", position: "relative", overflow: "hidden", minHeight: 420 }}>

          {/* Site nav */}
          <div style={{ background: "white", padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid #E5E7EB" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 26, height: 26, borderRadius: 6, background: "#16A34A", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ color: "white", fontSize: 10, fontWeight: 700 }}>K</span>
              </div>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#111827" }}>KasiTek</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              {["Services", "About", "Contact"].map(l => (
                <span key={l} style={{ fontSize: 10, color: "#6B7280" }}>{l}</span>
              ))}
              <div style={{ background: scenario.accent, color: "white", fontSize: 9, fontWeight: 600, padding: "4px 10px", borderRadius: 6 }}>Book Now</div>
            </div>
          </div>

          {/* Hero strip */}
          <div style={{ background: "white", padding: "16px 16px 14px", borderBottom: "1px solid #E5E7EB" }}>
            <div style={{ height: 14, background: "#1F2937", borderRadius: 4, width: "40%", marginBottom: 8 }} />
            <div style={{ height: 9, background: "#D1D5DB", borderRadius: 4, width: "62%", marginBottom: 5 }} />
            <div style={{ height: 9, background: "#E5E7EB", borderRadius: 4, width: "48%", marginBottom: 14 }} />
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ background: scenario.accent, color: "white", fontSize: 10, fontWeight: 600, padding: "6px 14px", borderRadius: 7 }}>Get a Free Quote</div>
              <div style={{ background: "transparent", border: "1px solid #D1D5DB", color: "#374151", fontSize: 10, padding: "6px 14px", borderRadius: 7 }}>Our Services</div>
            </div>
          </div>

          {/* Service cards */}
          <div style={{ padding: "14px 16px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            {[
              { label: "Electrical", icon: "⚡", color: "#FEF3C7" },
              { label: "Solar", icon: "☀️", color: "#D1FAE5" },
              { label: "Security", icon: "🔐", color: "#EDE9FE" },
            ].map((card, i) => (
              <div key={i} style={{ background: "white", border: "1px solid #E5E7EB", borderRadius: 10, padding: 10 }}>
                <div style={{ width: 28, height: 28, borderRadius: 8, background: card.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, marginBottom: 8 }}>{card.icon}</div>
                <div style={{ height: 8, background: "#1F2937", borderRadius: 3, width: "65%", marginBottom: 5 }} />
                <div style={{ height: 6, background: "#E5E7EB", borderRadius: 3, width: "85%", marginBottom: 3 }} />
                <div style={{ height: 6, background: "#E5E7EB", borderRadius: 3, width: "70%" }} />
              </div>
            ))}
          </div>

          {/* Chat widget — bottom right, floating above page */}
          <div style={{ position: "absolute", bottom: 14, right: 14, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10, width: 250 }}>

            {/* Chat window */}
            <div style={{ width: "100%", borderRadius: 14, overflow: "hidden", boxShadow: "0 8px 32px rgba(0,0,0,0.18)", border: "1px solid rgba(0,0,0,0.07)" }}>

              {/* Header */}
              <div style={{ background: scenario.accent, padding: "10px 12px", display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ position: "relative", flexShrink: 0 }}>
                  <div style={{ width: 30, height: 30, borderRadius: "50%", background: "rgba(255,255,255,0.22)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: "white" }}>K</div>
                  <div style={{ position: "absolute", bottom: -1, right: -1, width: 10, height: 10, background: "#86EFAC", borderRadius: "50%", border: "2px solid " + scenario.accent }} />
                </div>
                <div style={{ flex: 1 }}>
                  <p style={{ color: "white", fontSize: 12, fontWeight: 600, margin: 0, lineHeight: 1.3 }}>KasiTek Assistant</p>
                  <p style={{ color: "rgba(255,255,255,0.75)", fontSize: 10, margin: 0 }}>Online · replies instantly</p>
                </div>
                <svg style={{ width: 14, height: 14, stroke: "rgba(255,255,255,0.6)", fill: "none", flexShrink: 0 }} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12"/></svg>
              </div>

              {/* Messages */}
              <div style={{ background: "#F8FAFC", padding: "12px 10px", display: "flex", flexDirection: "column", gap: 8, minHeight: 190, overflow: "hidden" }}>
                {scenario.steps.map((s, i) => {
                  const visible = msgStep > i;
                  if (s.kind === "agent") return (
                    <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-end", opacity: visible ? 1 : 0, transform: visible ? "none" : "translateY(5px)", transition: "all 0.4s ease" }}>
                      <div style={{ width: 22, height: 22, borderRadius: "50%", background: scenario.accent, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, color: "white", flexShrink: 0, marginBottom: 2 }}>K</div>
                      <div style={{ background: "white", borderRadius: "14px 14px 14px 4px", padding: "8px 11px", fontSize: 11.5, color: "#1F2937", boxShadow: "0 1px 3px rgba(0,0,0,0.08)", maxWidth: "85%", lineHeight: 1.5 }}>{s.text}</div>
                    </div>
                  );
                  if (s.kind === "user") return (
                    <div key={i} style={{ display: "flex", justifyContent: "flex-end", opacity: visible ? 1 : 0, transform: visible ? "none" : "translateY(5px)", transition: "all 0.4s ease" }}>
                      <div style={{ background: scenario.accent, borderRadius: "14px 14px 4px 14px", padding: "8px 11px", fontSize: 11.5, color: "white", maxWidth: "82%", lineHeight: 1.5 }}>{s.text}</div>
                    </div>
                  );
                  if (s.kind === "quick-replies") return (
                    <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: 6, paddingLeft: 30, opacity: visible ? 1 : 0, transition: "opacity 0.4s ease" }}>
                      {s.options.map((opt, j) => (
                        <button key={j} style={{ fontSize: 10, fontWeight: 500, padding: "4px 10px", borderRadius: 20, background: `${scenario.accent}18`, color: scenario.accent, border: `1px solid ${scenario.accent}40` }}>{opt}</button>
                      ))}
                    </div>
                  );
                  if (s.kind === "form") return (
                    <div key={i} style={{ opacity: visible ? 1 : 0, transform: visible ? "none" : "translateY(5px)", transition: "all 0.4s ease" }}>
                      <div style={{ background: "white", borderRadius: "14px 14px 14px 4px", padding: "10px 11px", boxShadow: "0 1px 3px rgba(0,0,0,0.08)", display: "flex", flexDirection: "column", gap: 6 }}>
                        {s.fields.map((f, j) => (
                          <div key={j} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", border: "1px solid #E5E7EB", borderRadius: 8, padding: "5px 9px" }}>
                            <span style={{ fontSize: 10, color: "#9CA3AF" }}>{f.label}</span>
                            <span style={{ fontSize: 10, fontWeight: 600, color: "#374151" }}>{f.value}</span>
                          </div>
                        ))}
                        <button style={{ width: "100%", background: scenario.accent, color: "white", fontSize: 11, fontWeight: 600, padding: "7px 0", borderRadius: 8, border: "none" }}>{s.submit}</button>
                      </div>
                    </div>
                  );
                  if (s.kind === "success") return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 11px", borderRadius: 12, opacity: visible ? 1 : 0, transform: visible ? "none" : "translateY(5px)", transition: "all 0.4s ease", background: `${scenario.accent}12`, border: `1px solid ${scenario.accent}30` }}>
                      <svg style={{ width: 14, height: 14, stroke: scenario.accent, fill: "none", flexShrink: 0 }} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7"/></svg>
                      <p style={{ fontSize: 11, fontWeight: 600, color: scenario.accent, margin: 0 }}>{s.text}</p>
                    </div>
                  );
                  return null;
                })}

                {/* Typing dots */}
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end", opacity: showTyping ? 1 : 0, transition: "opacity 0.3s" }}>
                  <div style={{ width: 22, height: 22, borderRadius: "50%", background: scenario.accent, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, color: "white", flexShrink: 0 }}>K</div>
                  <div style={{ background: "white", borderRadius: "14px 14px 14px 4px", padding: "9px 13px", boxShadow: "0 1px 3px rgba(0,0,0,0.08)", display: "flex", gap: 4 }}>
                    {[0,1,2].map(i => <span key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: "#CBD5E1", display: "inline-block", animation: `bounce 1s ease infinite ${i*0.15}s` }} />)}
                  </div>
                </div>
              </div>

              {/* Input bar */}
              <div style={{ background: "white", padding: "8px 10px", display: "flex", alignItems: "center", gap: 8, borderTop: "1px solid #F1F5F9" }}>
                <div style={{ flex: 1, background: "#F8FAFC", borderRadius: 20, padding: "7px 14px", fontSize: 11, color: "#9CA3AF", border: "1px solid #E5E7EB" }}>Type a message...</div>
                <div style={{ width: 28, height: 28, borderRadius: "50%", background: scenario.accent, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: `0 2px 8px ${scenario.accent}55` }}>
                  <svg style={{ width: 13, height: 13, fill: "white" }} viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                </div>
              </div>
            </div>

            {/* FAB */}
            <div style={{ width: 42, height: 42, borderRadius: "50%", background: scenario.accent, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: `0 4px 16px ${scenario.accent}66` }}>
              <svg style={{ width: 20, height: 20, fill: "white" }} viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
            </div>
          </div>
        </div>
      </div>
    </div>
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
        <div className="mb-4 flex items-center gap-3">
          <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">Live Demo</span>
          <span className="w-px h-3 bg-white/10" />
          <h3 className="font-display text-xl leading-none text-foreground">{activeService.title}</h3>
        </div>

        {renderDemo(activeService.demoKind)}
      </div>
    </section>
  );
}
