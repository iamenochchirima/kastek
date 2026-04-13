"use client";

interface WebAgentMockupProps {
  scenario?: "lead" | "booking" | "quote";
}

export default function WebAgentMockup({ scenario = "lead" }: WebAgentMockupProps) {
  return (
    <div className="w-full max-w-xl mx-auto">
      <div className="bg-gray-100 rounded-2xl overflow-hidden shadow-2xl border border-gray-200">
        {/* Browser chrome */}
        <div className="bg-gray-700 px-4 py-2.5 flex items-center gap-3">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-400"></div>
            <div className="w-3 h-3 rounded-full bg-yellow-400"></div>
            <div className="w-3 h-3 rounded-full bg-green-400"></div>
          </div>
          <div className="flex-1 bg-gray-600 rounded-md px-3 py-1 flex items-center gap-2">
            <svg className="w-3 h-3 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <p className="text-gray-300 text-xs truncate">yourwebsite.co.za</p>
          </div>
        </div>

        {/* Webpage content */}
        <div className="relative bg-white" style={{ height: 420 }}>
          {/* Fake page background */}
          <div className="p-6 select-none pointer-events-none">
            <div className="h-5 bg-gray-100 rounded w-1/3 mb-3"></div>
            <div className="h-3 bg-gray-100 rounded w-2/3 mb-2"></div>
            <div className="h-3 bg-gray-100 rounded w-1/2 mb-6"></div>
            <div className="grid grid-cols-3 gap-3 mb-6">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-24 bg-gray-50 rounded-xl border border-gray-100"></div>
              ))}
            </div>
            <div className="h-3 bg-gray-100 rounded w-full mb-2"></div>
            <div className="h-3 bg-gray-100 rounded w-5/6 mb-2"></div>
            <div className="h-3 bg-gray-100 rounded w-4/6 mb-2"></div>
          </div>

          {/* Floating chat widget — bottom right */}
          <div className="absolute bottom-4 right-4 flex flex-col items-end gap-2" style={{ width: 280 }}>
            {/* Chat window */}
            <div className="w-full bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-hidden">
              {/* Widget header */}
              <div className="bg-green-700 px-4 py-3 flex items-center gap-2.5">
                <div className="relative">
                  <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center text-sm font-bold text-white">K</div>
                  <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-green-400 rounded-full border-2 border-green-700"></div>
                </div>
                <div className="flex-1">
                  <p className="text-white text-xs font-semibold leading-tight">KasiTek Assistant</p>
                  <p className="text-green-200 text-[10px] leading-tight">Online — typically replies instantly</p>
                </div>
                <button className="text-white/60 hover:text-white">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Messages area */}
              <div className="p-3 space-y-2.5" style={{ background: "#f0f4f8", minHeight: 220 }}>
                {scenario === "lead" && (
                  <>
                    <div className="flex gap-2 items-end">
                      <div className="w-5 h-5 rounded-full bg-green-700 flex items-center justify-center text-[9px] text-white font-bold flex-shrink-0 mb-0.5">K</div>
                      <div className="bg-white rounded-2xl rounded-bl-sm px-3 py-2 text-[11px] text-gray-800 shadow-sm max-w-[85%] leading-relaxed">
                        Hi! 👋 How can I help you today? I can help you book a demo, get pricing, or answer any questions.
                      </div>
                    </div>
                    <div className="flex gap-1.5 ml-7 flex-wrap">
                      {["Request Demo", "Get Pricing", "Talk to Sales"].map((label) => (
                        <button key={label} className="bg-green-600 text-white text-[10px] px-2.5 py-1 rounded-full font-medium shadow-sm whitespace-nowrap">
                          {label}
                        </button>
                      ))}
                    </div>
                    <div className="flex justify-end">
                      <div className="bg-green-600 rounded-2xl rounded-br-sm px-3 py-2 text-[11px] text-white shadow-sm max-w-[80%]">
                        I&apos;d like to request a demo
                      </div>
                    </div>
                    <div className="flex gap-2 items-end">
                      <div className="w-5 h-5 rounded-full bg-green-700 flex items-center justify-center text-[9px] text-white font-bold flex-shrink-0 mb-0.5">K</div>
                      <div className="bg-white rounded-2xl rounded-bl-sm px-3 py-2 text-[11px] text-gray-800 shadow-sm max-w-[85%]">
                        <p className="font-semibold mb-1.5 text-gray-900">Quick details for your demo</p>
                        <div className="space-y-1.5">
                          {["Your name", "Email address", "Business type"].map((f) => (
                            <div key={f} className="bg-gray-100 rounded-lg px-2.5 py-1.5 text-[10px] text-gray-400 border border-gray-200">{f}</div>
                          ))}
                        </div>
                        <button className="mt-2 w-full bg-green-600 text-white text-[10px] py-1.5 rounded-lg font-semibold">
                          Book Demo Slot →
                        </button>
                      </div>
                    </div>
                  </>
                )}

                {scenario === "booking" && (
                  <>
                    <div className="flex gap-2 items-end">
                      <div className="w-5 h-5 rounded-full bg-green-700 flex items-center justify-center text-[9px] text-white font-bold flex-shrink-0 mb-0.5">K</div>
                      <div className="bg-white rounded-2xl rounded-bl-sm px-3 py-2 text-[11px] text-gray-800 shadow-sm max-w-[85%] leading-relaxed">
                        I can book an appointment for you. Which service do you need?
                      </div>
                    </div>
                    <div className="flex gap-1.5 ml-7 flex-wrap">
                      {["Electrical Inspection", "Plumbing", "Consultation"].map((label) => (
                        <button key={label} className="bg-green-600 text-white text-[10px] px-2.5 py-1 rounded-full font-medium whitespace-nowrap">
                          {label}
                        </button>
                      ))}
                    </div>
                    <div className="flex justify-end">
                      <div className="bg-green-600 rounded-2xl rounded-br-sm px-3 py-2 text-[11px] text-white shadow-sm">
                        Electrical Inspection
                      </div>
                    </div>
                    <div className="flex gap-2 items-end">
                      <div className="w-5 h-5 rounded-full bg-green-700 flex items-center justify-center text-[9px] text-white font-bold flex-shrink-0 mb-0.5">K</div>
                      <div className="bg-white rounded-2xl rounded-bl-sm px-3 py-2 text-[11px] text-gray-800 shadow-sm max-w-[85%]">
                        <p className="font-semibold text-green-700 mb-2">Available slots this week</p>
                        <div className="grid grid-cols-2 gap-1.5">
                          {["Mon 09:00", "Tue 10:00", "Wed 14:00", "Thu 11:00"].map((s) => (
                            <button key={s} className="bg-green-50 border border-green-200 text-green-800 text-[10px] px-2 py-1.5 rounded-lg font-medium">{s}</button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </>
                )}

                {scenario === "quote" && (
                  <>
                    <div className="flex gap-2 items-end">
                      <div className="w-5 h-5 rounded-full bg-green-700 flex items-center justify-center text-[9px] text-white font-bold flex-shrink-0 mb-0.5">K</div>
                      <div className="bg-white rounded-2xl rounded-bl-sm px-3 py-2 text-[11px] text-gray-800 shadow-sm max-w-[85%] leading-relaxed">
                        I can prepare a quote for you. What items do you need priced?
                      </div>
                    </div>
                    <div className="flex justify-end">
                      <div className="bg-green-600 rounded-2xl rounded-br-sm px-3 py-2 text-[11px] text-white shadow-sm max-w-[80%] leading-relaxed">
                        8 circuit breakers, 4 distribution boards, and cable
                      </div>
                    </div>
                    <div className="flex gap-2 items-end">
                      <div className="w-5 h-5 rounded-full bg-green-700 flex items-center justify-center text-[9px] text-white font-bold flex-shrink-0 mb-0.5">K</div>
                      <div className="bg-white rounded-2xl rounded-bl-sm px-3 py-2 text-[11px] text-gray-800 shadow-sm max-w-[85%]">
                        <div className="flex items-center gap-1.5 mb-2">
                          <div className="w-5 h-5 bg-orange-100 rounded flex items-center justify-center">
                            <svg className="w-3 h-3 text-orange-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                          </div>
                          <p className="font-semibold text-orange-600">Quotation Ready — R 5,320</p>
                        </div>
                        <div className="flex gap-1.5">
                          <button className="flex-1 bg-orange-500 text-white text-[10px] py-1.5 rounded-lg font-semibold">Download PDF</button>
                          <button className="flex-1 border border-gray-200 text-gray-600 text-[10px] py-1.5 rounded-lg">Email Me</button>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* Input bar */}
              <div className="bg-white px-3 py-2.5 flex items-center gap-2 border-t border-gray-100">
                <div className="flex-1 bg-gray-100 rounded-full px-3 py-1.5 text-[10px] text-gray-400 border border-gray-200">
                  Type a message...
                </div>
                <button className="w-7 h-7 rounded-full bg-green-600 flex items-center justify-center flex-shrink-0 shadow-sm">
                  <svg className="w-3.5 h-3.5 text-white" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Floating launcher button */}
            <button className="w-12 h-12 rounded-full bg-green-700 flex items-center justify-center shadow-xl self-end">
              <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24">
                <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
