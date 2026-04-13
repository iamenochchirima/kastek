"use client";

export default function PartnerMockup() {
  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden shadow-lg">
        <div className="p-4 border-b border-gray-100">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white text-xs font-bold">AB</div>
                <div>
                  <p className="text-xs font-bold text-gray-800">Alpha Business Solutions</p>
                  <p className="text-[10px] text-gray-500">Powered by KasiTek infrastructure</p>
                </div>
              </div>
            </div>
            <span className="text-[9px] bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-semibold">White-label</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: "Active Clients", value: "12", icon: "👥" },
              { label: "Automations", value: "38", icon: "⚡" },
              { label: "Revenue Share", value: "R 14k", icon: "💰" },
            ].map((s, i) => (
              <div key={i} className="bg-gray-50 rounded-xl p-2 text-center">
                <div className="text-base mb-0.5">{s.icon}</div>
                <p className="text-sm font-bold text-gray-800">{s.value}</p>
                <p className="text-[9px] text-gray-500">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="p-3">
          <p className="text-[10px] font-semibold text-gray-600 mb-2">Client Campaign Bundles</p>
          <div className="space-y-1.5">
            {[
              { client: "Soweto Hardware", status: "Active", campaign: "WhatsApp + Booking", color: "bg-green-100 text-green-700" },
              { client: "City Clinic Group", status: "Active", campaign: "Booking + Follow-up", color: "bg-green-100 text-green-700" },
              { client: "TechZone Retail", status: "Setup", campaign: "Quote + Catalogue", color: "bg-yellow-100 text-yellow-700" },
              { client: "SA Electrical Co.", status: "Active", campaign: "Full Suite", color: "bg-green-100 text-green-700" },
            ].map((c, i) => (
              <div key={i} className="flex items-center gap-2 p-2 bg-gray-50 rounded-lg">
                <div className="w-6 h-6 rounded-md bg-indigo-100 flex items-center justify-center text-[10px] font-bold text-indigo-600 flex-shrink-0">
                  {c.client[0]}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-semibold text-gray-800 truncate">{c.client}</p>
                  <p className="text-[9px] text-gray-500 truncate">{c.campaign}</p>
                </div>
                <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${c.color} flex-shrink-0`}>{c.status}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-gradient-to-br from-green-800 to-green-700 rounded-2xl p-4 text-white shadow-lg">
        <p className="text-xs font-bold mb-2">What KasiTek handles for you</p>
        <div className="space-y-1.5">
          {[
            "AI infrastructure and hosting",
            "WhatsApp API setup and compliance",
            "Ongoing model updates and tuning",
            "Client onboarding and setup flows",
            "Custom domain + white-label delivery",
          ].map((item, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-full bg-white/20 flex items-center justify-center flex-shrink-0">
                <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="text-[10px] text-green-100">{item}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
