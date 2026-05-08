"use client";

import Image from "next/image";

function AgencyVisual() {
  const clients = [
    { initials: "SW", name: "Soweto Hardware", campaign: "WhatsApp + Booking", status: "Active", color: "#3DBA7A" },
    { initials: "CC", name: "City Clinic Group", campaign: "Booking + Follow-up", status: "Active", color: "#3DBA7A" },
    { initials: "TZ", name: "TechZone Retail", campaign: "Quote + Catalogue", status: "Setup", color: "#E8A020" },
    { initials: "SA", name: "SA Electrical Co.", campaign: "Full Suite", status: "Active", color: "#3DBA7A" },
  ];

  return (
    <div className="w-full max-w-lg space-y-3">
      {/* Partner dashboard mockup */}
      <div className="rounded-2xl border border-white/10 bg-[#0D0D0D] overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/8 bg-[#111]">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-[#E8A020]/20 flex items-center justify-center text-xs font-bold text-[#E8A020]">P</div>
            <div>
              <p className="text-white text-xs font-semibold leading-tight">Partner Portal</p>
              <p className="text-[10px] text-white/40 leading-tight">White-label dashboard</p>
            </div>
          </div>
          <span className="text-[9px] bg-[#3DBA7A]/15 text-[#3DBA7A] px-2 py-0.5 rounded-full font-semibold border border-[#3DBA7A]/20">White-label</span>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-px bg-white/5 mx-4 mt-4 rounded-xl overflow-hidden">
          {[
            { label: "Active clients", value: "12", color: "#E8A020" },
            { label: "Automations", value: "38", color: "#3DBA7A" },
            { label: "Rev share", value: "R14k", color: "#60A5FA" },
          ].map((s, i) => (
            <div key={i} className="bg-[#0D0D0D] p-3 text-center">
              <p className="text-base font-bold" style={{ color: s.color }}>{s.value}</p>
              <p className="text-[9px] text-white/40 mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Client list */}
        <div className="p-4 space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/30 mb-3">Client Campaigns</p>
          {clients.map((c, i) => (
            <div key={i} className="flex items-center gap-2.5 rounded-xl bg-white/[0.03] border border-white/6 p-2.5">
              <div className="w-7 h-7 rounded-lg bg-[#E8A020]/10 flex items-center justify-center text-[10px] font-bold text-[#E8A020] flex-shrink-0">
                {c.initials}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-white/90 truncate leading-tight">{c.name}</p>
                <p className="text-[10px] text-white/40 truncate leading-tight">{c.campaign}</p>
              </div>
              <span className="text-[9px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0"
                style={{ color: c.color, background: `${c.color}18`, border: `1px solid ${c.color}30` }}>
                {c.status}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function VendorVisual() {
  return (
    <div className="w-full max-w-lg space-y-3">
      {/* Platform embed mockup */}
      <div className="rounded-2xl border border-white/10 bg-[#0D0D0D] overflow-hidden shadow-2xl">
        {/* Browser bar */}
        <div className="flex items-center gap-3 px-4 py-2.5 bg-[#111] border-b border-white/8">
          <div className="flex gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-white/15" />
            <div className="w-2.5 h-2.5 rounded-full bg-white/15" />
            <div className="w-2.5 h-2.5 rounded-full bg-white/15" />
          </div>
          <div className="flex-1 bg-white/5 rounded-md px-3 py-1 flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-[#60A5FA]/40 flex-shrink-0" />
            <p className="text-white/30 text-[10px] truncate">app.yourplatform.io/dashboard</p>
          </div>
        </div>

        {/* Platform content */}
        <div className="p-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-[10px] text-white/30 uppercase tracking-widest mb-1">Customer Activity</p>
              <p className="text-sm font-semibold text-white/90">YourProduct AI Layer</p>
            </div>
            <span className="text-[9px] bg-[#60A5FA]/15 text-[#60A5FA] px-2 py-0.5 rounded-full border border-[#60A5FA]/20 font-semibold">Embedded</span>
          </div>

          <div className="grid grid-cols-2 gap-2 mb-4">
            {[
              { label: "Sessions today", value: "1,284", color: "#60A5FA" },
              { label: "AI deflections", value: "91%", color: "#3DBA7A" },
              { label: "Avg response", value: "1.2s", color: "#E8A020" },
              { label: "Tenants active", value: "47", color: "#A78BFA" },
            ].map((s, i) => (
              <div key={i} className="rounded-xl bg-white/[0.03] border border-white/6 p-3">
                <p className="text-base font-bold" style={{ color: s.color }}>{s.value}</p>
                <p className="text-[10px] text-white/40 mt-0.5">{s.label}</p>
              </div>
            ))}
          </div>

          <div className="rounded-xl bg-white/[0.03] border border-white/8 p-3 space-y-2">
            <p className="text-[10px] font-semibold text-white/40 uppercase tracking-widest">Feature flags</p>
            {[
              { label: "Conversation agent", enabled: true },
              { label: "Quote automation", enabled: true },
              { label: "Campaign module", enabled: false },
            ].map((f, i) => (
              <div key={i} className="flex items-center justify-between">
                <p className="text-xs text-white/70">{f.label}</p>
                <div className={`w-6 h-3 rounded-full transition-colors flex-shrink-0 ${f.enabled ? "bg-[#3DBA7A]/70" : "bg-white/10"}`} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function FranchiseVisual() {
  const branches = [
    { name: "Sandton", calls: 84, bookings: 12, status: "live" },
    { name: "Soweto", calls: 67, bookings: 9, status: "live" },
    { name: "Pretoria", calls: 0, bookings: 0, status: "setup" },
    { name: "Durban", calls: 0, bookings: 0, status: "planned" },
  ];

  return (
    <div className="w-full max-w-lg">
      <div className="rounded-2xl border border-white/10 bg-[#0D0D0D] overflow-hidden shadow-2xl opacity-80">
        <div className="px-4 py-3 border-b border-white/8 bg-[#111] flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-white/80">Franchise Control Centre</p>
            <p className="text-[10px] text-white/30">Multi-location overview</p>
          </div>
          <span className="text-[9px] border border-[#A78BFA]/30 bg-[#A78BFA]/10 text-[#A78BFA] px-2 py-0.5 rounded-full font-semibold">Coming Soon</span>
        </div>

        <div className="p-4 space-y-2">
          <p className="text-[10px] text-white/30 uppercase tracking-widest mb-3">Branch Status</p>
          {branches.map((b, i) => (
            <div key={i} className="flex items-center gap-3 rounded-xl bg-white/[0.03] border border-white/6 p-3">
              <div className="w-8 h-8 rounded-lg bg-[#A78BFA]/10 flex items-center justify-center text-xs font-bold text-[#A78BFA] flex-shrink-0">
                {b.name[0]}
              </div>
              <div className="flex-1">
                <p className="text-xs font-semibold text-white/80">{b.name}</p>
                {b.status === "live" ? (
                  <p className="text-[10px] text-white/40">{b.calls} conversations · {b.bookings} bookings</p>
                ) : (
                  <p className="text-[10px] text-white/30 capitalize">{b.status}…</p>
                )}
              </div>
              <span className="text-[9px] px-1.5 py-0.5 rounded-full font-medium capitalize"
                style={
                  b.status === "live"
                    ? { color: "#3DBA7A", background: "rgba(61,186,122,0.12)", border: "1px solid rgba(61,186,122,0.2)" }
                    : { color: "#ffffff50", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)" }
                }>
                {b.status}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface CategoryHeroVisualProps {
  slug: string;
}

export function CategoryHeroVisual({ slug }: CategoryHeroVisualProps) {
  if (slug === "smbs") {
    return (
      <div className="relative w-full max-w-md">
        {/* Ambient glow behind the image */}
        <div className="absolute -inset-4 rounded-3xl opacity-40 blur-2xl pointer-events-none"
          style={{ background: "radial-gradient(ellipse at 30% 60%, #3DBA7A33, transparent 60%), radial-gradient(ellipse at 70% 30%, #E8A02033, transparent 60%)" }} />
        <div className="relative rounded-2xl overflow-hidden shadow-2xl border border-white/8">
          <Image
            src="/images/smb-hero-v3.png"
            alt="AI-powered chat services running on mobile"
            width={700}
            height={933}
            className="w-full h-auto object-cover"
            priority
          />
          {/* Subtle bottom gradient so it blends into the dark page */}
          <div className="absolute bottom-0 left-0 right-0 h-32 pointer-events-none"
            style={{ background: "linear-gradient(to top, #0A0A0A 0%, transparent 100%)" }} />
        </div>
      </div>
    );
  }

  if (slug === "agencies") {
    return <AgencyVisual />;
  }

  if (slug === "software-vendors") {
    return <VendorVisual />;
  }

  if (slug === "franchises") {
    return <FranchiseVisual />;
  }

  return null;
}
