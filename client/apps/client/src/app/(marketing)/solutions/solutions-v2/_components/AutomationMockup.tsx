"use client";

export default function AutomationMockup() {
  const flows = [
    { icon: "📩", label: "Lead captured", sublabel: "WhatsApp / Web form", color: "bg-blue-50 border-blue-200", iconBg: "bg-blue-100" },
    { icon: "⏰", label: "Follow-up sent at 24h", sublabel: "Automated warm message", color: "bg-green-50 border-green-200", iconBg: "bg-green-100" },
    { icon: "📅", label: "Reminder: 2h before", sublabel: "Appointment confirmation", color: "bg-purple-50 border-purple-200", iconBg: "bg-purple-100" },
    { icon: "⭐", label: "Review requested", sublabel: "After service completed", color: "bg-yellow-50 border-yellow-200", iconBg: "bg-yellow-100" },
    { icon: "🔄", label: "Re-engage stale leads", sublabel: "After 7 days of silence", color: "bg-orange-50 border-orange-200", iconBg: "bg-orange-100" },
  ];

  const stats = [
    { label: "Replies Captured", value: "84%", color: "text-green-600" },
    { label: "Follow-ups Sent", value: "1,200", color: "text-blue-600" },
    { label: "Reviews Requested", value: "312", color: "text-yellow-600" },
    { label: "Bookings Confirmed", value: "247", color: "text-purple-600" },
  ];

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden shadow-lg">
        <div className="bg-gradient-to-r from-gray-800 to-gray-700 px-4 py-3 flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse"></div>
          <span className="text-white text-xs font-semibold">Automation Queue — Live</span>
        </div>
        <div className="p-3 space-y-2">
          {flows.map((f, i) => (
            <div key={i} className={`flex items-center gap-3 p-2.5 rounded-xl border ${f.color}`}>
              <div className={`w-8 h-8 rounded-lg ${f.iconBg} flex items-center justify-center text-base flex-shrink-0`}>{f.icon}</div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-gray-800 leading-tight">{f.label}</p>
                <p className="text-[10px] text-gray-500 leading-tight">{f.sublabel}</p>
              </div>
              <div className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0"></div>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden shadow-lg">
        <div className="bg-gradient-to-r from-green-700 to-green-600 px-4 py-3">
          <span className="text-white text-xs font-semibold">Reporting Snapshot — This Month</span>
        </div>
        <div className="grid grid-cols-2 gap-px bg-gray-100">
          {stats.map((s, i) => (
            <div key={i} className="bg-white p-3 text-center">
              <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
              <p className="text-[10px] text-gray-500 mt-0.5 leading-tight">{s.label}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
