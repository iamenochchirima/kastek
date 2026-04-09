"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";

type Service = {
  id: string;
  label: string;
  color: string;
  duration: string;
  headline: string;
  description: string;
  cta: string;
  icon: React.ReactNode;
  thumbnail: React.ReactNode;
};

const services: Service[] = [
  {
    id: "website",
    label: "Website Agent",
    color: "#E8A020",
    duration: "2:14",
    headline: "Never miss a website lead again",
    description:
      "Your AI agent greets visitors, answers questions, qualifies leads, and captures contact details around the clock.",
    cta: "/get-quote?service=Website%20Agent",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    ),
    thumbnail: (
      <div className="flex h-full w-full flex-col">
        <div className="relative flex flex-1 items-center justify-center overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-[#E8A020]/10 via-transparent to-transparent" />
          <div className="relative z-10 w-[70%] max-w-[340px] overflow-hidden rounded-xl border border-[#252525] bg-[#0D0D0D] shadow-2xl">
            <div className="flex items-center gap-2 border-b border-[#1a1a1a] bg-[#111111] px-4 py-2">
              <div className="flex gap-1">
                <div className="h-2 w-2 rounded-full bg-[#ff5f57]" />
                <div className="h-2 w-2 rounded-full bg-[#febc2e]" />
                <div className="h-2 w-2 rounded-full bg-[#28c840]" />
              </div>
              <div className="flex-1 rounded bg-[#1a1a1a] px-2 py-0.5 text-[9px] text-[#4a4a4a]">
                yoursite.co.za
              </div>
            </div>
            <div className="space-y-2 p-4">
              <div className="mb-2 flex items-center gap-1.5">
                <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#3DBA7A]" />
                <span className="text-[9px] font-semibold text-[#3DBA7A]">Agent Online</span>
              </div>
              {[
                { reply: false, text: "Hi! Can I help you find what you're looking for?" },
                { reply: true, text: "What's your pricing?" },
                { reply: false, text: "Plans from R499/month. Want me to connect you now?" },
              ].map((message, index) => (
                <div key={index} className={`flex ${message.reply ? "justify-end" : ""}`}>
                  <div
                    className={`max-w-[80%] rounded-lg px-2.5 py-1.5 text-[9px] leading-relaxed ${
                      message.reply
                        ? "border border-[#E8A020]/30 bg-[#E8A020]/20 text-[#F2EDE6]"
                        : "border border-[#252525] bg-[#1a1a1a] text-[#F2EDE6]"
                    }`}
                  >
                    {message.text}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="px-6 pb-4 pt-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-[#E8A020]">
            Website Agent
          </p>
          <p className="mt-0.5 text-[13px] font-medium text-[#F2EDE6]">
            Watch live lead capture in action
          </p>
        </div>
      </div>
    ),
  },
  {
    id: "whatsapp",
    label: "WhatsApp Agent",
    color: "#25D366",
    duration: "2:48",
    headline: "Every WhatsApp message answered instantly",
    description:
      "Your agent handles FAQs, booking, lead qualification, and escalation without needing constant human attention.",
    cta: "/get-quote?service=WhatsApp%20Agent",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
    thumbnail: (
      <div className="flex h-full w-full flex-col">
        <div className="relative flex flex-1 items-center justify-center overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-[#25D366]/8 via-transparent to-transparent" />
          <div className="relative z-10 w-[55%] max-w-[280px] overflow-hidden rounded-2xl border border-[#252525] bg-[#0D0D0D] shadow-2xl">
            <div className="flex items-center gap-2 border-b border-[#1a1a1a] bg-[#111111] px-3 py-2">
              <div className="flex h-6 w-6 items-center justify-center rounded-full border border-[#25D366]/30 bg-[#25D366]/20 text-[9px] font-bold text-[#25D366]">
                K
              </div>
              <div>
                <p className="text-[9px] font-semibold text-[#F2EDE6]">KasiTek Agent</p>
                <p className="text-[8px] text-[#3DBA7A]">● online</p>
              </div>
            </div>
            <div className="space-y-2 p-3">
              {[
                { reply: true, text: "Do you still have the R450 geyser special?" },
                { reply: false, text: "Yes. What area are you in?" },
                { reply: true, text: "Randburg" },
                { reply: false, text: "We cover Randburg. Morning or afternoon?" },
                { reply: true, text: "Morning please" },
                { reply: false, text: "Booked. Technician 8–10am tomorrow." },
              ].map((message, index) => (
                <div key={index} className={`flex ${message.reply ? "justify-end" : ""}`}>
                  <div
                    className={`max-w-[85%] rounded-lg px-2 py-1.5 text-[8.5px] leading-relaxed ${
                      message.reply
                        ? "border border-[#25D366]/20 bg-[#25D366]/15 text-[#F2EDE6]"
                        : "border border-[#252525] bg-[#1a1a1a] text-[#F2EDE6]"
                    }`}
                  >
                    {message.text}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="px-6 pb-4 pt-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-[#25D366]">
            WhatsApp Agent
          </p>
          <p className="mt-0.5 text-[13px] font-medium text-[#F2EDE6]">
            See a booking handled end-to-end
          </p>
        </div>
      </div>
    ),
  },
  {
    id: "catalogue",
    label: "WhatsApp Catalogue Agent",
    color: "#34D399",
    duration: "2:22",
    headline: "Sell from WhatsApp like a real shop assistant",
    description:
      "Customers browse your catalogue conversationally, ask product questions, compare options, and place an order without needing a website.",
    cta: "/get-quote?service=WhatsApp%20Catalogue%20Agent",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 2h12l4 7-10 13L2 9l4-7z" />
        <path d="M6 2l6 20" />
        <path d="M18 2 12 22" />
        <path d="M2 9h20" />
      </svg>
    ),
    thumbnail: (
      <div className="flex h-full w-full flex-col">
        <div className="relative flex flex-1 items-center justify-center overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-[#34D399]/8 via-transparent to-transparent" />
          <div className="relative z-10 w-[58%] max-w-[300px] overflow-hidden rounded-2xl border border-[#252525] bg-[#0D0D0D] shadow-2xl">
            <div className="flex items-center gap-2 border-b border-[#1a1a1a] bg-[#111111] px-3 py-2">
              <div className="flex h-6 w-6 items-center justify-center rounded-full border border-[#34D399]/30 bg-[#34D399]/20 text-[9px] font-bold text-[#34D399]">
                C
              </div>
              <div>
                <p className="text-[9px] font-semibold text-[#F2EDE6]">Corner Shop Agent</p>
                <p className="text-[8px] text-[#34D399]">catalogue live</p>
              </div>
            </div>
            <div className="space-y-2 p-3">
              {[
                { reply: true, text: "Do you have size 6 school shoes?" },
                { reply: false, text: "Yes. Black lace-up or velcro?" },
                { reply: true, text: "Black velcro please" },
                { reply: false, text: "We have Bata at R320 and SmartWalk at R260." },
                { reply: true, text: "Send me the cheaper one with socks too" },
                { reply: false, text: "Added. Total is R310. Can I confirm delivery area?" },
              ].map((message, index) => (
                <div key={index} className={`flex ${message.reply ? "justify-end" : ""}`}>
                  <div
                    className={`max-w-[85%] rounded-lg px-2 py-1.5 text-[8.5px] leading-relaxed ${
                      message.reply
                        ? "border border-[#34D399]/20 bg-[#34D399]/15 text-[#F2EDE6]"
                        : "border border-[#252525] bg-[#1a1a1a] text-[#F2EDE6]"
                    }`}
                  >
                    {message.text}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="px-6 pb-4 pt-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-[#34D399]">
            WhatsApp Catalogue Agent
          </p>
          <p className="mt-0.5 text-[13px] font-medium text-[#F2EDE6]">
            Catalogue browsing and ordering inside chat
          </p>
        </div>
      </div>
    ),
  },
  {
    id: "campaigns",
    label: "Bulk Campaigns",
    color: "#E8A020",
    duration: "1:52",
    headline: "Reach your customer list in minutes",
    description:
      "Broadcast WhatsApp messages to opted-in contacts, then track delivery, read rate, and replies in one place.",
    cta: "/get-quote?service=Bulk%20Campaigns",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
      </svg>
    ),
    thumbnail: (
      <div className="flex h-full w-full flex-col">
        <div className="relative flex flex-1 items-center justify-center overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-[#E8A020]/6 via-transparent to-transparent" />
          <div className="relative z-10 w-[70%] max-w-[320px] space-y-2">
            <div className="rounded-xl border border-[#1e1e1e] bg-[#111111] p-3">
              <p className="mb-1 text-[8px] uppercase tracking-wider text-[#7A7570]">
                To: All Customers (1,240)
              </p>
              <p className="text-[10px] leading-relaxed text-[#F2EDE6]">
                Hey {"{{name}}"} 20% off this weekend only. Reply YES to claim.
              </p>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {[
                { label: "Delivered", value: "94%", color: "#E8A020" },
                { label: "Read", value: "61%", color: "#3DBA7A" },
                { label: "Replies", value: "238", color: "#F2EDE6" },
              ].map((stat) => (
                <div key={stat.label} className="rounded-lg border border-[#1e1e1e] bg-[#111111] p-2 text-center">
                  <p className="mb-0.5 font-display text-xl leading-none" style={{ color: stat.color }}>
                    {stat.value}
                  </p>
                  <p className="text-[8px] text-[#7A7570]">{stat.label}</p>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-[#3DBA7A]/15 bg-[#3DBA7A]/8 px-3 py-1.5">
              <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#3DBA7A]" />
              <p className="text-[9px] font-semibold text-[#3DBA7A]">Campaign sent · 3 minutes ago</p>
            </div>
          </div>
        </div>
        <div className="px-6 pb-4 pt-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-[#E8A020]">
            Bulk Campaigns
          </p>
          <p className="mt-0.5 text-[13px] font-medium text-[#F2EDE6]">
            From campaign draft to 1,240 delivered
          </p>
        </div>
      </div>
    ),
  },
  {
    id: "social",
    label: "Social Content",
    color: "#E1306C",
    duration: "2:05",
    headline: "Your social media, running on autopilot",
    description:
      "AI-generated posts for Facebook, Instagram, and WhatsApp Status, tailored to your brand and ready to publish.",
    cta: "/get-quote?service=Social%20Content",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8m-4-4v4" />
      </svg>
    ),
    thumbnail: (
      <div className="flex h-full w-full flex-col">
        <div className="relative flex flex-1 items-center justify-center overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-[#E1306C]/6 via-transparent to-transparent" />
          <div className="relative z-10 w-[72%] max-w-[330px] space-y-2">
            <div className="mb-1 flex items-center justify-between">
              <p className="text-[8px] font-semibold uppercase tracking-wider text-[#7A7570]">
                Content Calendar
              </p>
              <span className="rounded border border-[#E8A020]/20 bg-[#E8A020]/10 px-2 py-0.5 text-[8px] font-semibold text-[#E8A020]">
                AI Generated
              </span>
            </div>
            {[
              { day: "Mon", platform: "Facebook", status: "published", color: "#3DBA7A" },
              { day: "Wed", platform: "Instagram", status: "scheduled", color: "#E8A020" },
              { day: "Fri", platform: "WhatsApp", status: "draft", color: "#7A7570" },
            ].map((post) => (
              <div key={post.day} className="flex items-center gap-3 rounded-lg border border-[#1e1e1e] bg-[#111111] p-2.5">
                <div className="w-8 shrink-0 text-center">
                  <p className="font-display text-base leading-none text-[#E8A020]">{post.day}</p>
                  <p className="text-[7px] text-[#4a4a4a]">{post.platform}</p>
                </div>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#1a1a1a]">
                  <div className="h-full w-3/4 rounded-full bg-[#2a2a2a]" />
                </div>
                <span
                  className="rounded px-1.5 py-0.5 text-[8px] font-semibold"
                  style={{
                    color: post.color,
                    background: `${post.color}15`,
                    border: `1px solid ${post.color}25`,
                  }}
                >
                  {post.status}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="px-6 pb-4 pt-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-[#E1306C]">
            Social Content
          </p>
          <p className="mt-0.5 text-[13px] font-medium text-[#F2EDE6]">
            30 days of posts, generated in 60 seconds
          </p>
        </div>
      </div>
    ),
  },
  {
    id: "quote",
    label: "Quote Automation",
    color: "#7C3AED",
    duration: "1:38",
    headline: "Send quotes in seconds, not hours",
    description:
      "Customers describe the job. Your agent fills your pricing template and sends a professional quote automatically.",
    cta: "/get-quote?service=Quote%20Automation",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
      </svg>
    ),
    thumbnail: (
      <div className="flex h-full w-full flex-col">
        <div className="relative flex flex-1 items-center justify-center overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-[#7C3AED]/6 via-transparent to-transparent" />
          <div className="relative z-10 w-[65%] max-w-[300px] overflow-hidden rounded-xl border border-[#252525] bg-[#0D0D0D]">
            <div className="flex items-center justify-between border-b border-[#1a1a1a] bg-[#111111] px-3 py-2">
              <p className="text-[9px] font-semibold text-[#F2EDE6]">Quote #QT-00847</p>
              <span className="rounded border border-[#3DBA7A]/20 bg-[#3DBA7A]/10 px-1.5 py-0.5 text-[8px] font-semibold text-[#3DBA7A]">
                Sent 12s ago
              </span>
            </div>
            <div className="p-3">
              <div className="mb-3 flex justify-between">
                <div>
                  <p className="text-[7px] text-[#7A7570]">Client</p>
                  <p className="text-[10px] font-semibold text-[#F2EDE6]">Sipho D.</p>
                </div>
                <div className="text-right">
                  <p className="text-[7px] text-[#7A7570]">Total</p>
                  <p className="font-display text-xl text-[#E8A020]">R2,850</p>
                </div>
              </div>
              {[
                { description: "Geyser replacement", price: "R2,200" },
                { description: "Call-out fee", price: "R450" },
                { description: "Pipe fittings", price: "R200" },
              ].map((line) => (
                <div key={line.description} className="mb-1 flex justify-between text-[8px]">
                  <span className="text-[#7A7570]">{line.description}</span>
                  <span className="text-[#F2EDE6]">{line.price}</span>
                </div>
              ))}
              <div className="mt-3 grid grid-cols-2 gap-1.5">
                <div className="rounded py-1.5 text-center text-[8px] font-bold text-black bg-[#E8A020]">
                  Accept
                </div>
                <div className="rounded border border-[#1e1e1e] py-1.5 text-center text-[8px] text-[#7A7570]">
                  Decline
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="px-6 pb-4 pt-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-[#7C3AED]">
            Quote Automation
          </p>
          <p className="mt-0.5 text-[13px] font-medium text-[#F2EDE6]">
            WhatsApp message to signed quote in 12 seconds
          </p>
        </div>
      </div>
    ),
  },
  {
    id: "voice",
    label: "Voice Agent",
    color: "#06B6D4",
    duration: "3:01",
    headline: "AI that answers your phone calls",
    description:
      "A natural-sounding voice agent handles FAQs, books appointments, and transfers to you when needed.",
    cta: "/get-quote?service=Voice%20Agent",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.62 1h3a2 2 0 0 1 2 1.72c.23.944.48 1.876.73 2.81a2 2 0 0 1-.45 2.11L8.09 9a16 16 0 0 0 6.29 6.29l.91-.91a2 2 0 0 1 2.11-.45c.91.348 1.86.567 2.82.65A2 2 0 0 1 22 16.92z" />
      </svg>
    ),
    thumbnail: (
      <div className="flex h-full w-full flex-col">
        <div className="relative flex flex-1 items-center justify-center overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-[#06B6D4]/6 via-transparent to-transparent" />
          <div className="relative z-10 flex flex-col items-center gap-5">
            <div className="relative flex items-center justify-center">
              {[0, 1, 2].map((index) => (
                <div
                  key={index}
                  className="absolute animate-ping rounded-full border border-[#06B6D4]/20"
                  style={{
                    width: `${56 + index * 22}px`,
                    height: `${56 + index * 22}px`,
                    animationDelay: `${index * 0.4}s`,
                    animationDuration: "1.8s",
                  }}
                />
              ))}
              <div className="relative z-10 flex h-14 w-14 items-center justify-center rounded-full border border-[#06B6D4]/35 bg-[#06B6D4]/15">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#06B6D4" strokeWidth="1.5">
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.62 1h3a2 2 0 0 1 2 1.72c.23.944.48 1.876.73 2.81a2 2 0 0 1-.45 2.11L8.09 9a16 16 0 0 0 6.29 6.29l.91-.91a2 2 0 0 1 2.11-.45c.91.348 1.86.567 2.82.65A2 2 0 0 1 22 16.92z" />
                </svg>
              </div>
            </div>
            <div className="text-center">
              <p className="text-[11px] font-semibold text-[#F2EDE6]">+27 11 234 5678 · 02:14</p>
              <p className="mt-0.5 text-[9px] font-semibold text-[#06B6D4]">● Call in progress</p>
            </div>
            <div className="flex h-8 items-center gap-1">
              {[3, 6, 10, 7, 4, 9, 5, 8, 3, 7, 10, 5, 6].map((height, index) => (
                <motion.div
                  key={index}
                  className="w-1 rounded-full bg-[#06B6D4]/60"
                  animate={{ height: [`${height * 2}px`, `${height * 3.5}px`, `${height * 2}px`] }}
                  transition={{ repeat: Infinity, duration: 0.8 + index * 0.07, ease: "easeInOut" }}
                />
              ))}
            </div>
            <div className="w-[200px] space-y-1.5 rounded-lg border border-[#1e1e1e] bg-[#111111] p-2.5">
              {[
                { speaker: "Caller", text: "Can I book for Friday morning?" },
                { speaker: "Agent", text: "I have 9am and 11am free. Which works?" },
              ].map((line) => (
                <p key={line.speaker} className="text-[8.5px]">
                  <span className="font-semibold text-[#7A7570]">{line.speaker}: </span>
                  <span className="text-[#F2EDE6]">{line.text}</span>
                </p>
              ))}
            </div>
          </div>
        </div>
        <div className="px-6 pb-4 pt-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-[#06B6D4]">
            Voice Agent
          </p>
          <p className="mt-0.5 text-[13px] font-medium text-[#F2EDE6]">
            Watch a call get handled and booked automatically
          </p>
        </div>
      </div>
    ),
  },
];

function ServiceDemoPlayer({ service }: { service: Service }) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setPlaying(false);
    setProgress(0);
    if (intervalRef.current) clearInterval(intervalRef.current);
  }, [service.id]);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  function handlePlay() {
    setPlaying(true);
    intervalRef.current = setInterval(() => {
      setProgress((value) => {
        if (value >= 100) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          setPlaying(false);
          return 100;
        }
        return value + 0.4;
      });
    }, 80);
  }

  const [minutes, seconds] = service.duration.split(":").map((value) => parseInt(value, 10));
  const totalSeconds = minutes * 60 + seconds;
  const elapsed = Math.floor((progress / 100) * totalSeconds);
  const elapsedMinutes = Math.floor(elapsed / 60).toString();
  const elapsedSeconds = (elapsed % 60).toString().padStart(2, "0");

  return (
    <div
      className="group relative h-full overflow-hidden rounded-2xl border border-[#1e1e1e] bg-[#0D0D0D] shadow-[0_24px_80px_rgba(0,0,0,0.6)]"
      style={{
        boxShadow: `0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04), inset 0 0 0 1px ${service.color}10`,
      }}
    >
      <div className="absolute inset-0 pb-14">{service.thumbnail}</div>

      <AnimatePresence>
        {playing ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 flex items-center justify-center bg-black/55 pb-14"
            style={{ backdropFilter: "blur(2px)" }}
          >
            <div className="flex flex-col items-center gap-3">
              <div className="text-4xl">▶</div>
              <div className="w-48 text-center">
                <p className="mb-1 text-sm font-semibold text-[#F2EDE6]">{service.label}</p>
                <p className="text-[11px] text-[#7A7570]">Demo preview playing...</p>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {!playing ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40 pb-14 opacity-0 transition-opacity group-hover:opacity-100">
          <motion.button
            type="button"
            onClick={handlePlay}
            whileHover={{ scale: 1.08 }}
            whileTap={{ scale: 0.94 }}
            className="pointer-events-auto flex h-16 w-16 items-center justify-center rounded-full shadow-xl"
            style={{ background: service.color }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="black">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          </motion.button>
        </div>
      ) : null}

      {!playing && progress === 0 ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center pb-14">
          <div
            className="flex h-14 w-14 items-center justify-center rounded-full opacity-80 shadow-xl"
            style={{ background: service.color, boxShadow: `0 0 40px ${service.color}60` }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="black">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          </div>
        </div>
      ) : null}

      <div className="absolute inset-x-0 bottom-0 flex h-14 flex-col justify-center gap-1.5 border-t border-[#1a1a1a] bg-[#0A0A0A]/95 px-4">
        <div
          className="relative h-1 cursor-pointer overflow-hidden rounded-full bg-[#1e1e1e]"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const next = ((event.clientX - rect.left) / rect.width) * 100;
            setProgress(Math.max(0, Math.min(100, next)));
          }}
        >
          <motion.div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ background: service.color, width: `${progress}%` }}
            transition={{ duration: 0 }}
          />
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                if (playing) {
                  setPlaying(false);
                  if (intervalRef.current) clearInterval(intervalRef.current);
                } else {
                  handlePlay();
                }
              }}
              className="flex h-6 w-6 items-center justify-center rounded-full transition-colors hover:bg-white/10"
              style={{ color: service.color }}
            >
              {playing ? (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="4" width="4" height="16" />
                  <rect x="14" y="4" width="4" height="16" />
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              )}
            </button>
            <span className="font-mono text-[10px] text-[#7A7570]">
              {elapsedMinutes}:{elapsedSeconds} / {service.duration}
            </span>
          </div>
          <span
            className="rounded px-2 py-0.5 text-[10px] font-semibold"
            style={{
              color: service.color,
              background: `${service.color}15`,
              border: `1px solid ${service.color}25`,
            }}
          >
            {service.label}
          </span>
        </div>
      </div>

      <div className="absolute inset-x-0 top-0 h-0.5 rounded-t-2xl" style={{ background: service.color, opacity: 0.5 }} />
    </div>
  );
}

export default function DemoPage() {
  const [activeService, setActiveService] = useState(0);
  const active = services[activeService];

  return (
    <main className="relative min-h-screen w-full overflow-x-hidden bg-[#080808] font-sans text-[#F2EDE6] selection:bg-primary/30 selection:text-primary">
      <div
        className="pointer-events-none fixed inset-0 z-50 opacity-[0.025]"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
        }}
      />
      <Navbar />

      <section className="px-6 pb-8 pt-32 md:px-12 md:pt-40">
        <div className="mx-auto max-w-5xl text-center">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.25em] text-[#E8A020]">
              Demo Playlist
            </p>
            <h1 className="font-display text-5xl leading-none text-[#F2EDE6] md:text-7xl">
              See your business <span className="text-[#E8A020]">on autopilot.</span>
            </h1>
          </motion.div>
        </div>
      </section>

      <section className="border-t border-[#1a1a1a] px-6 py-16 md:px-12">
        <div className="mx-auto max-w-6xl">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#E8A020]">
                Demo Playlist
              </p>
              <p className="text-sm text-[#7A7570]">
                <span className="font-semibold text-[#F2EDE6]">
                  {activeService + 1} of {services.length}
                </span>{" "}
                — {active.label}
              </p>
            </div>
            <div className="hidden items-center gap-2 text-[11px] text-[#4a4a4a] md:flex">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M5 12h14m-7-7 7 7-7 7" />
              </svg>
              Click a card to switch
            </div>
          </div>

          <div className="-mx-2 mb-10 flex gap-3 overflow-x-auto px-2 pb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {services.map((service, index) => {
              const isActive = activeService === index;

              return (
                <motion.button
                  key={service.id}
                  type="button"
                  onClick={() => setActiveService(index)}
                  whileHover={{ y: -3 }}
                  whileTap={{ scale: 0.97 }}
                  className="w-44 flex-shrink-0 overflow-hidden rounded-xl border text-left transition-all duration-200 focus:outline-none"
                  style={{
                    background: isActive ? `${service.color}10` : "#111111",
                    borderColor: isActive ? `${service.color}40` : "#1e1e1e",
                    boxShadow: isActive ? `0 0 20px ${service.color}18` : "none",
                  }}
                >
                  <div
                    className="relative h-24 overflow-hidden"
                    style={{ background: `linear-gradient(135deg, ${service.color}14 0%, #0D0D0D 70%)` }}
                  >
                    <span
                      className="absolute left-3 top-2 font-display text-3xl leading-none"
                      style={{ color: isActive ? service.color : "#2a2a2a" }}
                    >
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <div className="absolute bottom-2 right-3" style={{ color: isActive ? service.color : "#3a3a3a" }}>
                      {service.icon}
                    </div>
                    {isActive ? (
                      <motion.div
                        layoutId="activeBar"
                        className="absolute inset-x-0 bottom-0 h-0.5"
                        style={{ background: service.color }}
                      />
                    ) : null}
                    <div
                      className={`absolute right-2.5 top-2 flex items-center gap-1 rounded px-1.5 py-0.5 text-[8px] font-semibold ${
                        isActive ? "bg-[#E8A020] text-black" : "bg-black/60 text-[#7A7570]"
                      }`}
                    >
                      <svg width="7" height="7" viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                      {isActive ? "Playing" : service.duration}
                    </div>
                  </div>
                  <div className="px-3 py-2.5">
                    <p className={`text-[12px] font-semibold leading-tight ${isActive ? "text-[#F2EDE6]" : "text-[#7A7570]"}`}>
                      {service.label}
                    </p>
                    <p className={`mt-0.5 text-[10px] ${isActive ? "text-[#7A7570]" : "text-[#3a3a3a]"}`}>
                      {service.duration} · Demo
                    </p>
                  </div>
                </motion.button>
              );
            })}
          </div>

          <AnimatePresence mode="wait">
            <motion.div
              key={active.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              className="grid grid-cols-1 items-center gap-8 lg:grid-cols-2"
            >
              <div className="order-2 lg:order-1">
                <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-[#1e1e1e] bg-[#111111] px-3 py-1.5">
                  <span style={{ color: active.color }}>{active.icon}</span>
                  <span className="text-[11px] font-semibold text-[#7A7570]">{active.label}</span>
                  <span className="ml-1 text-[10px] text-[#4a4a4a]">· {active.duration}</span>
                </div>
                <h3 className="mb-4 font-display text-4xl leading-none md:text-5xl">{active.headline}</h3>
                <p className="mb-8 max-w-md text-sm leading-relaxed text-[#7A7570]">{active.description}</p>
                <div className="flex flex-wrap gap-3">
                  <Link
                    href={active.cta}
                    className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-[#E8A020] px-6 py-3 text-sm font-semibold text-black shadow-[0_0_24px_rgba(232,160,32,0.25)] transition-all hover:shadow-[0_0_36px_rgba(232,160,32,0.4)]"
                  >
                    Book this setup
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M5 12h14m-7-7 7 7-7 7" />
                    </svg>
                  </Link>
                  <Link
                    href="/pricing"
                    className="inline-flex items-center gap-2 rounded-xl border border-[#1e1e1e] px-6 py-3 text-sm font-semibold text-[#F2EDE6] transition-all hover:border-[#2a2a2a] hover:bg-white/[0.03]"
                  >
                    See pricing
                  </Link>
                </div>
              </div>

              <div className="order-1 h-[420px] lg:order-2">
                <ServiceDemoPlayer service={active} />
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      </section>

      <section className="border-t border-[#1a1a1a] bg-[#0A0A0A] px-6 py-16 md:px-12">
        <div className="mx-auto max-w-5xl">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="mb-10 text-center"
          >
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.25em] text-[#E8A020]">
              From the field
            </p>
            <h2 className="font-display text-4xl leading-none md:text-5xl">What SMBs are saying</h2>
          </motion.div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {[
              {
                quote:
                  "The WhatsApp agent booked 3 jobs while I was on-site. I didn't miss a single lead.",
                name: "Thabo M.",
                role: "Plumbing business, Joburg",
                initial: "T",
                service: "WhatsApp Agent",
              },
              {
                quote:
                  "Our bulk campaign hit 94% delivery rate. Email never gave us that level of reach.",
                name: "Lerato K.",
                role: "Salon owner, Pretoria",
                initial: "L",
                service: "Bulk Campaigns",
              },
              {
                quote:
                  "The voice agent handles our call overflow. Customers don't even know it's AI.",
                name: "Sipho D.",
                role: "HVAC services, Cape Town",
                initial: "S",
                service: "Voice Agent",
              },
            ].map((testimonial, index) => (
              <motion.div
                key={testimonial.name}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1, duration: 0.5 }}
                className="rounded-xl border border-[#1e1e1e] bg-[#111111] p-6 transition-colors hover:border-[#E8A020]/20"
              >
                <div className="mb-4 flex items-center justify-between">
                  <div className="flex gap-0.5">
                    {[...Array(5)].map((_, starIndex) => (
                      <span key={starIndex} className="text-sm text-[#E8A020]">★</span>
                    ))}
                  </div>
                  <span className="rounded border border-[#E8A020]/15 bg-[#E8A020]/8 px-2 py-0.5 text-[9px] font-semibold text-[#E8A020]">
                    {testimonial.service}
                  </span>
                </div>
                <p className="mb-5 text-[13px] italic leading-relaxed text-[#F2EDE6]">
                  "{testimonial.quote}"
                </p>
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full border border-[#E8A020]/25 bg-[#E8A020]/15">
                    <span className="text-xs font-bold text-[#E8A020]">{testimonial.initial}</span>
                  </div>
                  <div>
                    <p className="text-[12px] font-semibold text-[#F2EDE6]">{testimonial.name}</p>
                    <p className="text-[10px] text-[#7A7570]">{testimonial.role}</p>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      <Footer />
    </main>
  );
}
