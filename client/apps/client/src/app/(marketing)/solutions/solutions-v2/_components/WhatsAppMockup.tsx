"use client";

import { useState, useEffect } from "react";

interface Message {
  type: "in" | "out";
  text: string;
  time: string;
  attachment?: "booking" | "quote-pdf" | "catalogue";
  delay?: number;
}

interface WhatsAppMockupProps {
  messages: Message[];
  title?: string;
  subtitle?: string;
  autoAnimate?: boolean;
}

function BookingCard() {
  return (
    <div className="mt-1 bg-white rounded-xl overflow-hidden shadow-sm border border-green-100">
      <div className="bg-green-600 px-3 py-2 flex items-center gap-2">
        <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        <span className="text-white text-xs font-semibold">Appointment Confirmed</span>
      </div>
      <div className="p-3">
        <p className="text-xs font-semibold text-gray-800">Tuesday, 14 Jan at 10:00</p>
        <p className="text-xs text-gray-500 mt-0.5">Service: Electrical Inspection</p>
        <p className="text-xs text-gray-500">Location: 24 Ntuli Street, Soweto</p>
        <div className="mt-2 flex gap-2">
          <button className="flex-1 text-xs bg-green-600 text-white rounded-lg py-1.5 font-medium">View Details</button>
          <button className="flex-1 text-xs border border-gray-200 text-gray-600 rounded-lg py-1.5">Reschedule</button>
        </div>
      </div>
    </div>
  );
}

function QuotePdfCard() {
  return (
    <div className="mt-1 bg-white rounded-xl overflow-hidden shadow-sm border border-orange-100">
      <div className="bg-orange-500 px-3 py-2 flex items-center gap-2">
        <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <span className="text-white text-xs font-semibold">Quotation_001.pdf</span>
      </div>
      <div className="p-3">
        <p className="text-xs font-semibold text-gray-800">Electrical Equipment Quote</p>
        <div className="mt-1.5 space-y-0.5">
          <div className="flex justify-between text-xs text-gray-600">
            <span>8x Circuit Breaker 20A</span><span className="font-medium">R 1,240</span>
          </div>
          <div className="flex justify-between text-xs text-gray-600">
            <span>4x Distribution Board</span><span className="font-medium">R 3,600</span>
          </div>
          <div className="flex justify-between text-xs text-gray-600">
            <span>12x Cable 2.5mm (m)</span><span className="font-medium">R 480</span>
          </div>
        </div>
        <div className="mt-2 pt-2 border-t border-gray-100 flex justify-between">
          <span className="text-xs font-bold text-gray-800">Total</span>
          <span className="text-xs font-bold text-orange-600">R 5,320</span>
        </div>
        <div className="mt-2 flex gap-2">
          <button className="flex-1 text-xs bg-orange-500 text-white rounded-lg py-1.5 font-medium">Download PDF</button>
          <button className="flex-1 text-xs border border-gray-200 text-gray-600 rounded-lg py-1.5">Accept Quote</button>
        </div>
      </div>
    </div>
  );
}

function CatalogueCard() {
  const products = [
    { name: "Samsung 65\" QLED TV", price: "R 18,999", emoji: "📺" },
    { name: "Bosch Drill Kit Pro", price: "R 2,450", emoji: "🔧" },
    { name: "DB 12-Way Board", price: "R 890", emoji: "⚡" },
  ];
  return (
    <div className="mt-1 bg-white rounded-xl overflow-hidden shadow-sm border border-blue-100">
      <div className="bg-blue-600 px-3 py-2 flex items-center gap-2">
        <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
        </svg>
        <span className="text-white text-xs font-semibold">Product Catalogue</span>
      </div>
      <div className="p-2 space-y-1.5">
        {products.map((p, i) => (
          <div key={i} className="flex items-center gap-2 p-1.5 rounded-lg bg-gray-50">
            <span className="text-xl">{p.emoji}</span>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-gray-800 truncate">{p.name}</p>
              <p className="text-xs text-blue-600 font-semibold">{p.price}</p>
            </div>
            <button className="text-xs text-blue-600 border border-blue-200 px-2 py-0.5 rounded-md whitespace-nowrap">Add</button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function WhatsAppMockup({ messages, title = "KasiTek AI", subtitle = "Typically replies instantly", autoAnimate = false }: WhatsAppMockupProps) {
  const [visibleCount, setVisibleCount] = useState(autoAnimate ? 0 : messages.length);

  useEffect(() => {
    if (!autoAnimate) return;
    let count = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];
    messages.forEach((msg, i) => {
      const delay = (msg.delay ?? i * 1200) + 200;
      const t = setTimeout(() => {
        count++;
        setVisibleCount(count);
      }, delay);
      timers.push(t);
    });
    return () => timers.forEach(clearTimeout);
  }, [autoAnimate, messages]);

  return (
    <div className="relative mx-auto" style={{ width: 280 }}>
      <div className="bg-gray-800 rounded-[2.5rem] p-2.5 shadow-2xl">
        <div className="bg-white rounded-[2rem] overflow-hidden" style={{ height: 520 }}>
          <div className="bg-green-700 px-3 py-2.5 flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center text-base">🤖</div>
            <div className="flex-1 min-w-0">
              <p className="text-white text-xs font-semibold leading-tight">{title}</p>
              <p className="text-green-200 text-[10px] leading-tight">{subtitle}</p>
            </div>
            <svg className="w-4 h-4 text-white/70" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 7V5z" />
            </svg>
          </div>

          <div className="phone-screen h-full overflow-y-auto px-2.5 py-3 space-y-2 flex flex-col" style={{ maxHeight: 416 }}>
            {messages.slice(0, visibleCount).map((msg, i) => (
              <div key={i} className={`flex ${msg.type === "out" ? "justify-end" : "justify-start"} animate-fade-in-up`}>
                <div style={{ maxWidth: "80%" }}>
                  <div className={`px-3 py-1.5 text-[11px] leading-relaxed shadow-sm ${msg.type === "out" ? "whatsapp-bubble-out text-gray-800" : "whatsapp-bubble-in text-gray-800"}`}>
                    {msg.text}
                    {msg.attachment === "booking" && <BookingCard />}
                    {msg.attachment === "quote-pdf" && <QuotePdfCard />}
                    {msg.attachment === "catalogue" && <CatalogueCard />}
                  </div>
                  <p className={`text-[9px] text-gray-500 mt-0.5 ${msg.type === "out" ? "text-right" : "text-left"}`}>
                    {msg.time}
                    {msg.type === "out" && <span className="ml-1 text-blue-500">✓✓</span>}
                  </p>
                </div>
              </div>
            ))}
          </div>

          <div className="bg-gray-100 px-2.5 py-2 flex items-center gap-2 border-t border-gray-200">
            <div className="flex-1 bg-white rounded-full px-3 py-1.5 text-[10px] text-gray-400 shadow-sm">Message...</div>
            <div className="w-7 h-7 rounded-full bg-green-600 flex items-center justify-center shadow">
              <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
          </div>
        </div>
      </div>
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-20 h-5 bg-gray-800 rounded-b-2xl z-10"></div>
    </div>
  );
}

export type { Message };
