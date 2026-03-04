import { notFound } from "next/navigation";
import DownloadableCard from "@/components/fliers/downloadable-card";

export const metadata = {
  title: "Marketing Fliers | KasiTek",
  robots: "noindex",
};

export default function FliersPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <div className="min-h-screen bg-neutral-800 py-16 px-8 flex flex-col items-center gap-20">
      <p className="text-white/65 text-sm">
        Click &quot;Download as PNG&quot; below any card to save it
      </p>

      {/* Card 1: Main Services Overview */}
      <DownloadableCard filename="kasiai-services">
      <div className="w-[700px] bg-gradient-to-b from-[#0c0c0c] to-[#060606] rounded-none p-0 relative overflow-hidden shadow-2xl">
        {/* Top accent bar */}
        <div className="h-2 bg-gradient-to-r from-[#c4f04d] via-[#a8d43a] to-[#c4f04d]" />

        <div className="p-14">
          {/* Logo */}
          <div className="flex items-center gap-4 mb-8">
            <img src="/logo.png" alt="KasiTek" className="h-16 w-16" />
            <div>
              <span className="font-serif text-5xl text-white tracking-tight font-bold">
                Kasi<span className="text-[#c4f04d]">AI</span>
              </span>
              <p className="text-[#c4f04d] text-xs uppercase tracking-[0.2em] font-bold mt-1">
                AI Automation Solutions
              </p>
            </div>
          </div>

          {/* Headline */}
          <h2 className="text-[3.5rem] text-white leading-[1.05] mb-3 font-black uppercase">
            AI That Works
            <br />
            For Your Business
            <br />
            <span className="text-[#c4f04d]">24/7</span>
          </h2>
          <p className="text-white/65 text-lg mb-10 font-medium">
            Smart AI solutions built for your business.
          </p>

          {/* Divider */}
          <div className="h-1 w-20 bg-[#c4f04d] mb-10" />

          {/* Services */}
          <div className="space-y-6">
            <div className="flex items-center gap-5">
              <div className="w-14 h-14 rounded-lg bg-[#c4f04d] flex items-center justify-center text-2xl shrink-0">
                💬
              </div>
              <div>
                <h3 className="text-white text-xl font-extrabold uppercase">WhatsApp Chatbot</h3>
                <p className="text-white/60 text-sm font-medium">
                  Answers customers instantly — bookings, FAQs &amp; leads
                </p>
              </div>
            </div>

            <div className="flex items-center gap-5">
              <div className="w-14 h-14 rounded-lg bg-[#c4f04d] flex items-center justify-center text-2xl shrink-0">
                🌐
              </div>
              <div>
                <h3 className="text-white text-xl font-extrabold uppercase">Website Chatbot</h3>
                <p className="text-white/60 text-sm font-medium">
                  AI chat on your website that converts visitors into customers
                </p>
              </div>
            </div>

            <div className="flex items-center gap-5">
              <div className="w-14 h-14 rounded-lg bg-[#c4f04d] flex items-center justify-center text-2xl shrink-0">
                📞
              </div>
              <div>
                <h3 className="text-white text-xl font-extrabold uppercase">AI Voice Agent</h3>
                <p className="text-white/60 text-sm font-medium">
                  Answers phone calls like a real receptionist, takes bookings
                </p>
              </div>
            </div>

            <div className="flex items-center gap-5">
              <div className="w-14 h-14 rounded-lg bg-[#c4f04d] flex items-center justify-center text-2xl shrink-0">
                🤖
              </div>
              <div>
                <h3 className="text-white text-xl font-extrabold uppercase">Custom AI Agent</h3>
                <p className="text-white/60 text-sm font-medium">
                  Tailored AI for your exact needs — CRM, follow-ups &amp; reporting
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom CTA bar */}
        <div className="bg-[#c4f04d] px-14 py-6 flex items-center justify-between">
          <div>
            <p className="text-[#0a0a0a] text-xl font-black uppercase">Get a Free Quote</p>
            <p className="text-[#0a0a0a]/60 text-sm font-bold">kasitek.site/get-quote</p>
          </div>
          <div className="text-right">
            <p className="text-[#0a0a0a] text-xl font-black">+27 73 123 1909</p>
            <p className="text-[#0a0a0a]/60 text-sm font-bold">WhatsApp or Call</p>
          </div>
        </div>
      </div>
      </DownloadableCard>

      {/* Card 2: WhatsApp Chatbot Focus */}
      <DownloadableCard filename="kasiai-whatsapp-chatbot">
      <div className="w-[700px] bg-gradient-to-b from-[#0c0c0c] to-[#060606] rounded-none p-0 relative overflow-hidden shadow-2xl">
        <div className="h-2 bg-gradient-to-r from-[#c4f04d] via-[#a8d43a] to-[#c4f04d]" />

        <div className="p-14">
          <div className="flex items-center gap-4 mb-10">
            <img src="/logo.png" alt="KasiTek" className="h-14 w-14" />
            <span className="font-serif text-4xl text-white tracking-tight font-bold">
              Kasi<span className="text-[#c4f04d]">AI</span>
            </span>
          </div>

          <h2 className="text-[3.2rem] text-white leading-[1.05] mb-2 font-black uppercase">
            Stop Losing
            <br />
            Customers To
            <br />
            <span className="text-[#c4f04d]">Slow Replies!</span>
          </h2>
          <p className="text-white/65 text-lg mb-10 font-medium">
            Your AI WhatsApp chatbot answers customers instantly — even at 2am.
          </p>

          <div className="h-1 w-20 bg-[#c4f04d] mb-8" />

          <div className="space-y-4">
            {[
              "Answers FAQs, prices & directions instantly",
              "Handles bookings & appointments",
              "Captures leads while you sleep",
              "Sends you notifications for important messages",
              "Works 24/7 — never takes a day off",
              "No technical knowledge needed",
            ].map((item) => (
              <div key={item} className="flex items-center gap-4">
                <span className="text-[#c4f04d] text-2xl font-black">*</span>
                <span className="text-white text-lg font-semibold">{item}</span>
              </div>
            ))}
          </div>

          <div className="mt-10 bg-white/5 border-2 border-[#c4f04d]/30 p-6 text-center">
            <p className="text-white text-2xl font-black uppercase">
              Setup from R2,500
            </p>
            <p className="text-[#c4f04d] text-lg font-bold">
              Then just R300/month
            </p>
            <p className="text-white/60 text-sm font-medium mt-1">
              Cheaper than hiring. Smarter than a missed call.
            </p>
          </div>
        </div>

        <div className="bg-[#c4f04d] px-14 py-6 flex items-center justify-between">
          <div>
            <p className="text-[#0a0a0a] text-xl font-black uppercase">Get a Free Quote</p>
            <p className="text-[#0a0a0a]/60 text-sm font-bold">kasitek.site/get-quote</p>
          </div>
          <div className="text-right">
            <p className="text-[#0a0a0a] text-xl font-black">+27 73 123 1909</p>
            <p className="text-[#0a0a0a]/60 text-sm font-bold">WhatsApp or Call</p>
          </div>
        </div>
      </div>
      </DownloadableCard>

      {/* Card 3: Why KasiTek */}
      <DownloadableCard filename="kasiai-why-choose-us">
      <div className="w-[700px] bg-gradient-to-b from-[#0c0c0c] to-[#060606] rounded-none p-0 relative overflow-hidden shadow-2xl">
        <div className="h-2 bg-gradient-to-r from-[#c4f04d] via-[#a8d43a] to-[#c4f04d]" />

        <div className="p-14">
          <div className="flex items-center gap-4 mb-10">
            <img src="/logo.png" alt="KasiTek" className="h-14 w-14" />
            <span className="font-serif text-4xl text-white tracking-tight font-bold">
              Kasi<span className="text-[#c4f04d]">AI</span>
            </span>
          </div>

          <h2 className="text-[3.2rem] text-white leading-[1.05] mb-2 font-black uppercase">
            Why Businesses
            <br />
            <span className="text-[#c4f04d]">Choose KasiTek</span>
          </h2>
          <p className="text-white/65 text-lg mb-10 font-medium">
            Built for businesses that want to grow smarter.
          </p>

          <div className="h-1 w-20 bg-[#c4f04d] mb-10" />

          <div className="grid grid-cols-2 gap-4">
            {[
              { title: "24/7 Support", desc: "Your AI never sleeps, even on public holidays" },
              { title: "No Contracts", desc: "Month-to-month, cancel anytime" },
              { title: "We Set Up Everything", desc: "No technical skills needed from you" },
              { title: "Affordable", desc: "Setup from R2,500, monthly from R300" },
              { title: "Fully Custom", desc: "Tailored to how your business operates" },
              { title: "Multiple Channels", desc: "WhatsApp, website, voice — all covered" },
            ].map((item) => (
              <div
                key={item.title}
                className="bg-white/5 border border-white/10 p-5"
              >
                <h3 className="text-[#c4f04d] text-lg font-extrabold uppercase mb-1">{item.title}</h3>
                <p className="text-white/65 text-sm font-medium">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-[#c4f04d] px-14 py-6 flex items-center justify-between">
          <div>
            <p className="text-[#0a0a0a] text-xl font-black uppercase">Get a Free Quote</p>
            <p className="text-[#0a0a0a]/60 text-sm font-bold">kasitek.site/get-quote</p>
          </div>
          <div className="text-right">
            <p className="text-[#0a0a0a] text-xl font-black">+27 73 123 1909</p>
            <p className="text-[#0a0a0a]/60 text-sm font-bold">WhatsApp or Call</p>
          </div>
        </div>
      </div>
      </DownloadableCard>

      {/* Card 4: Brand Card */}
      <DownloadableCard filename="kasiai-brand">
      <div className="w-[700px] aspect-square bg-gradient-to-b from-[#0c0c0c] to-[#060606] rounded-none p-0 relative overflow-hidden shadow-2xl flex flex-col">
        <div className="h-2 bg-gradient-to-r from-[#c4f04d] via-[#a8d43a] to-[#c4f04d]" />

        <div className="flex-1 flex flex-col items-center justify-center text-center p-14">
          <img src="/logo.png" alt="KasiTek" className="h-24 w-24 mb-8" />
          <h2 className="text-6xl text-white tracking-tight font-black uppercase mb-2">
            Kasi<span className="text-[#c4f04d]">AI</span>
          </h2>
          <p className="text-white/60 text-sm uppercase tracking-[0.25em] font-bold mb-10">
            AI Automation for Your Business
          </p>

          <div className="h-1 w-16 bg-[#c4f04d] mb-10" />

          <div className="space-y-3 mb-10">
            <p className="text-white text-xl font-bold uppercase">WhatsApp Chatbots</p>
            <p className="text-white text-xl font-bold uppercase">Website Chatbots</p>
            <p className="text-white text-xl font-bold uppercase">AI Voice Agents</p>
            <p className="text-white text-xl font-bold uppercase">Custom AI Solutions</p>
          </div>

          <div className="h-1 w-16 bg-[#c4f04d] mb-10" />

          <p className="text-[#c4f04d] text-2xl font-black">kasitek.site</p>
          <p className="text-white/65 text-lg font-bold">WhatsApp or Call: +27 73 123 1909</p>
        </div>

        <div className="h-2 bg-gradient-to-r from-[#c4f04d] via-[#a8d43a] to-[#c4f04d]" />
      </div>
      </DownloadableCard>

      {/* Card 5: Quick Punch — Square */}
      <DownloadableCard filename="kasiai-quick-punch">
      <div className="w-[700px] aspect-square bg-gradient-to-b from-[#0c0c0c] to-[#060606] rounded-none p-0 relative overflow-hidden shadow-2xl flex flex-col">
        <div className="h-2 bg-gradient-to-r from-[#c4f04d] via-[#a8d43a] to-[#c4f04d]" />

        <div className="flex-1 flex flex-col justify-between p-14">
          <div className="flex items-center gap-4">
            <img src="/logo.png" alt="KasiTek" className="h-14 w-14" />
            <span className="font-serif text-4xl text-white tracking-tight font-bold">
              Kasi<span className="text-[#c4f04d]">AI</span>
            </span>
          </div>

          <div>
            <h2 className="text-[3.5rem] text-white leading-[1] mb-4 font-black uppercase">
              Your Customers
              <br />
              Don&apos;t Wait.
              <br />
              <span className="text-[#c4f04d]">Why Should
              <br />
              Your Replies?</span>
            </h2>
            <p className="text-white/60 text-lg font-medium">
              AI-powered chatbots for WhatsApp, your website &amp; phone calls.
            </p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-[#c4f04d] text-lg font-black uppercase">Get a Free Quote</p>
              <p className="text-white/60 text-sm font-bold">kasitek.site | +27 73 123 1909</p>
            </div>
            <div className="bg-[#c4f04d] text-[#0a0a0a] px-8 py-4 text-lg font-black uppercase">
              kasitek.site
            </div>
          </div>
        </div>
      </div>
      </DownloadableCard>

      {/* Card 6: Service Catalogue */}
      <DownloadableCard filename="kasiai-service-catalogue">
      <div className="w-[700px] bg-gradient-to-b from-[#0c0c0c] to-[#060606] rounded-none p-0 relative overflow-hidden shadow-2xl">
        <div className="h-2 bg-gradient-to-r from-[#c4f04d] via-[#a8d43a] to-[#c4f04d]" />

        <div className="p-14">
          {/* Header */}
          <div className="flex items-center gap-4 mb-8">
            <img src="/logo.png" alt="KasiTek" className="h-14 w-14" />
            <div>
              <span className="font-serif text-4xl text-white tracking-tight font-bold">
                Kasi<span className="text-[#c4f04d]">AI</span>
              </span>
              <p className="text-[#c4f04d] text-xs uppercase tracking-[0.2em] font-bold mt-1">
                Service Catalogue
              </p>
            </div>
          </div>

          <h2 className="text-[2.8rem] text-white leading-[1.05] mb-2 font-black uppercase">
            Our <span className="text-[#c4f04d]">Services</span>
            <br />
            &amp; Pricing
          </h2>
          <p className="text-white/65 text-base mb-10 font-medium">
            Transparent pricing. No hidden fees. Setup once, run 24/7.
          </p>

          <div className="h-1 w-20 bg-[#c4f04d] mb-8" />

          {/* Service cards */}
          <div className="space-y-4">
            {/* WhatsApp Chatbot */}
            <div className="bg-white/5 border border-white/10 p-5 flex items-start gap-5">
              <div className="w-12 h-12 rounded-lg bg-[#c4f04d] flex items-center justify-center text-xl shrink-0">
                💬
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between mb-1">
                  <h3 className="text-white text-lg font-extrabold uppercase">AI WhatsApp Chatbot</h3>
                </div>
                <p className="text-white/55 text-sm font-medium mb-3">
                  FAQ handling, bookings, lead capture &amp; auto-replies
                </p>
                <div className="flex items-center gap-4">
                  <div className="bg-[#c4f04d]/10 border border-[#c4f04d]/30 px-3 py-1.5">
                    <span className="text-[#c4f04d] text-sm font-black">R1,500 – R3,000</span>
                    <span className="text-white/50 text-xs font-semibold ml-1">setup</span>
                  </div>
                  <div className="bg-white/5 border border-white/10 px-3 py-1.5">
                    <span className="text-white text-sm font-black">R150 – R300</span>
                    <span className="text-white/50 text-xs font-semibold ml-1">/month</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Website Agent */}
            <div className="bg-white/5 border border-white/10 p-5 flex items-start gap-5">
              <div className="w-12 h-12 rounded-lg bg-[#c4f04d] flex items-center justify-center text-xl shrink-0">
                🌐
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between mb-1">
                  <h3 className="text-white text-lg font-extrabold uppercase">AI Website Agent</h3>
                </div>
                <p className="text-white/55 text-sm font-medium mb-3">
                  Live chat widget, visitor engagement &amp; lead capture
                </p>
                <div className="flex items-center gap-4">
                  <div className="bg-[#c4f04d]/10 border border-[#c4f04d]/30 px-3 py-1.5">
                    <span className="text-[#c4f04d] text-sm font-black">R1,500 – R3,500</span>
                    <span className="text-white/50 text-xs font-semibold ml-1">setup</span>
                  </div>
                  <div className="bg-white/5 border border-white/10 px-3 py-1.5">
                    <span className="text-white text-sm font-black">R200 – R400</span>
                    <span className="text-white/50 text-xs font-semibold ml-1">/month</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Voice Agent */}
            <div className="bg-white/5 border border-white/10 p-5 flex items-start gap-5">
              <div className="w-12 h-12 rounded-lg bg-[#c4f04d] flex items-center justify-center text-xl shrink-0">
                📞
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between mb-1">
                  <h3 className="text-white text-lg font-extrabold uppercase">AI Voice Agent</h3>
                </div>
                <p className="text-white/55 text-sm font-medium mb-3">
                  Inbound call handling, booking, routing &amp; after-hours support
                </p>
                <div className="flex items-center gap-4">
                  <div className="bg-[#c4f04d]/10 border border-[#c4f04d]/30 px-3 py-1.5">
                    <span className="text-[#c4f04d] text-sm font-black">R5,000 – R10,000</span>
                    <span className="text-white/50 text-xs font-semibold ml-1">setup</span>
                  </div>
                  <div className="bg-white/5 border border-white/10 px-3 py-1.5">
                    <span className="text-white text-sm font-black">R800 – R1,500</span>
                    <span className="text-white/50 text-xs font-semibold ml-1">/month</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Custom Agent */}
            <div className="bg-white/5 border border-white/10 p-5 flex items-start gap-5">
              <div className="w-12 h-12 rounded-lg bg-[#c4f04d] flex items-center justify-center text-xl shrink-0">
                🤖
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between mb-1">
                  <h3 className="text-white text-lg font-extrabold uppercase">Custom AI Agent</h3>
                </div>
                <p className="text-white/55 text-sm font-medium mb-3">
                  Custom AI workflows, CRM integrations &amp; advanced automations
                </p>
                <div className="flex items-center gap-4">
                  <div className="bg-[#c4f04d]/10 border border-[#c4f04d]/30 px-3 py-1.5">
                    <span className="text-[#c4f04d] text-sm font-black">R5,000 – R25,000+</span>
                    <span className="text-white/50 text-xs font-semibold ml-1">setup</span>
                  </div>
                  <div className="bg-white/5 border border-white/10 px-3 py-1.5">
                    <span className="text-white text-sm font-black">R500 – R2,500+</span>
                    <span className="text-white/50 text-xs font-semibold ml-1">/month</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Footer note */}
          <div className="mt-8 text-center">
            <p className="text-white/45 text-xs font-medium">
              Pricing depends on complexity &amp; integrations. Get a free consultation to find the right fit.
            </p>
          </div>
        </div>

        {/* Bottom CTA */}
        <div className="bg-[#c4f04d] px-14 py-6 flex items-center justify-between">
          <div>
            <p className="text-[#0a0a0a] text-xl font-black uppercase">Get a Free Quote</p>
            <p className="text-[#0a0a0a]/60 text-sm font-bold">kasitek.site/get-quote</p>
          </div>
          <div className="text-right">
            <p className="text-[#0a0a0a] text-xl font-black">+27 73 123 1909</p>
            <p className="text-[#0a0a0a]/60 text-sm font-bold">WhatsApp or Call</p>
          </div>
        </div>
      </div>
      </DownloadableCard>

      {/* ───── BANNERS SECTION ───── */}
      <div className="w-full border-t border-white/10 pt-16 mt-4 flex flex-col items-center gap-4">
        <h2 className="text-white text-2xl font-bold uppercase tracking-wide">
          Profile Banners
        </h2>
        <p className="text-white/50 text-sm mb-8">
          Facebook &amp; LinkedIn cover photos (820 &times; 312)
        </p>
      </div>

      {/* Banner 1: Clean Centered Brand */}
      <DownloadableCard filename="kasiai-banner-brand">
        <div className="w-[820px] h-[312px] bg-[#0a0a0a] relative overflow-hidden flex items-center justify-center">
          {/* Subtle grid dots */}
          <div className="absolute inset-0 opacity-[0.03]" style={{ backgroundImage: "radial-gradient(circle, #fff 1px, transparent 1px)", backgroundSize: "24px 24px" }} />
          {/* Top & bottom accent lines */}
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-transparent via-[#c4f04d] to-transparent" />
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r from-transparent via-[#c4f04d] to-transparent" />

          <div className="relative z-10 flex flex-col items-center text-center">
            <div className="flex items-center gap-4 mb-3">
              <img src="/logo.png" alt="KasiTek" className="h-14 w-14" />
              <span className="font-serif text-5xl text-white tracking-tight font-bold">
                Kasi<span className="text-[#c4f04d]">AI</span>
              </span>
            </div>
            <div className="h-0.5 w-12 bg-[#c4f04d] mb-3" />
            <p className="text-white/60 text-sm uppercase tracking-[0.3em] font-bold">
              AI Automation for Your Business
            </p>
            <div className="flex items-center gap-6 mt-5 text-white/70 text-xs font-semibold uppercase tracking-wider">
              <span>WhatsApp Chatbots</span>
              <span className="text-[#c4f04d]">&#x2022;</span>
              <span>Website Chatbots</span>
              <span className="text-[#c4f04d]">&#x2022;</span>
              <span>AI Voice Agents</span>
              <span className="text-[#c4f04d]">&#x2022;</span>
              <span>Custom AI</span>
            </div>
          </div>
        </div>
      </DownloadableCard>

      {/* Banner 2: Bold Split — Left Text, Right Services */}
      <DownloadableCard filename="kasiai-banner-services">
        <div className="w-[820px] h-[312px] bg-[#0a0a0a] relative overflow-hidden flex">
          <div className="absolute top-0 left-0 right-0 h-1 bg-[#c4f04d]" />

          {/* Left side */}
          <div className="flex-1 flex flex-col justify-center pl-14 pr-6">
            <div className="flex items-center gap-3 mb-4">
              <img src="/logo.png" alt="KasiTek" className="h-10 w-10" />
              <span className="font-serif text-3xl text-white tracking-tight font-bold">
                Kasi<span className="text-[#c4f04d]">AI</span>
              </span>
            </div>
            <h2 className="text-[2rem] text-white leading-[1.1] font-black uppercase">
              AI That Works
              <br />
              For Your
              <br />
              <span className="text-[#c4f04d]">Business</span>
            </h2>
            <p className="text-white/70 text-xs font-bold mt-3 uppercase tracking-wider">
              kasitek.site &nbsp;|&nbsp; +27 73 123 1909
            </p>
          </div>

          {/* Divider */}
          <div className="w-px bg-white/10 my-10" />

          {/* Right side — services grid */}
          <div className="flex-1 flex flex-col justify-center pl-8 pr-14 gap-4">
            {[
              { icon: "💬", label: "WhatsApp Chatbot" },
              { icon: "🌐", label: "Website Chatbot" },
              { icon: "📞", label: "AI Voice Agent" },
              { icon: "🤖", label: "Custom AI Agent" },
            ].map((s) => (
              <div key={s.label} className="flex items-center gap-3">
                <div className="w-9 h-9 rounded bg-[#c4f04d] flex items-center justify-center text-base shrink-0">
                  {s.icon}
                </div>
                <span className="text-white text-sm font-bold uppercase">{s.label}</span>
              </div>
            ))}
          </div>

          <div className="absolute bottom-0 left-0 right-0 h-1 bg-[#c4f04d]" />
        </div>
      </DownloadableCard>

      {/* Banner 3: Big Headline Punch */}
      <DownloadableCard filename="kasiai-banner-headline">
        <div className="w-[820px] h-[312px] bg-[#0a0a0a] relative overflow-hidden flex items-center">
          {/* Diagonal accent block */}
          <div className="absolute -right-20 -top-20 w-[280px] h-[400px] bg-[#c4f04d] rotate-12 opacity-[0.07]" />

          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-[#c4f04d] via-[#a8d43a] to-[#c4f04d]" />
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r from-[#c4f04d] via-[#a8d43a] to-[#c4f04d]" />

          <div className="relative z-10 px-14 flex items-center justify-between w-full">
            <div>
              <h2 className="text-[2.8rem] text-white leading-[1] font-black uppercase mb-2">
                Stop Losing
                <br />
                Customers To
                <br />
                <span className="text-[#c4f04d]">Slow Replies</span>
              </h2>
              <p className="text-white/70 text-sm font-semibold">
                AI chatbots for WhatsApp, web &amp; voice — 24/7
              </p>
            </div>

            <div className="flex flex-col items-center gap-3">
              <img src="/logo.png" alt="KasiTek" className="h-16 w-16" />
              <span className="font-serif text-3xl text-white tracking-tight font-bold">
                Kasi<span className="text-[#c4f04d]">AI</span>
              </span>
              <div className="bg-[#c4f04d] text-[#0a0a0a] px-5 py-2 text-xs font-black uppercase tracking-wide">
                kasitek.site
              </div>
            </div>
          </div>
        </div>
      </DownloadableCard>

      {/* Banner 4: Minimal Dark with Accent Strip */}
      <DownloadableCard filename="kasiai-banner-minimal">
        <div className="w-[820px] h-[312px] bg-[#0a0a0a] relative overflow-hidden flex items-center">
          {/* Left accent strip */}
          <div className="absolute left-0 top-0 bottom-0 w-2 bg-[#c4f04d]" />

          <div className="pl-16 pr-14 flex items-center justify-between w-full">
            {/* Left: Logo + Name */}
            <div className="flex items-center gap-5">
              <img src="/logo.png" alt="KasiTek" className="h-20 w-20" />
              <div>
                <span className="font-serif text-5xl text-white tracking-tight font-bold block">
                  Kasi<span className="text-[#c4f04d]">AI</span>
                </span>
                <p className="text-[#c4f04d] text-[0.65rem] uppercase tracking-[0.25em] font-bold mt-1">
                  AI Automation Solutions
                </p>
              </div>
            </div>

            {/* Right: stacked info */}
            <div className="text-right space-y-3">
              <div>
                <p className="text-white text-sm font-bold uppercase">WhatsApp &amp; Website Chatbots</p>
                <p className="text-white text-sm font-bold uppercase">AI Voice Agents</p>
                <p className="text-white text-sm font-bold uppercase">Custom AI Solutions</p>
              </div>
              <div className="h-0.5 w-full bg-white/10" />
              <div>
                <p className="text-[#c4f04d] text-base font-black">kasitek.site</p>
                <p className="text-white/70 text-xs font-bold">+27 73 123 1909 &nbsp;|&nbsp; WhatsApp or Call</p>
              </div>
            </div>
          </div>
        </div>
      </DownloadableCard>
    </div>
  );
}
