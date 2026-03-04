import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import QuoteRequestForm from "@/components/quote/quote-request-form";

export const metadata = {
  title: "Get a Quote | KasiTek",
  description:
    "Request a free quote for AI automation solutions for your South African business.",
};

export default function GetQuotePage() {
  return (
    <>
      <Navbar />
      <div className="flex flex-col items-center px-8 pt-32 pb-16 max-w-[640px] mx-auto min-h-screen max-sm:px-6 max-sm:pt-28 max-sm:pb-12">
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 bg-surface border border-border px-4 py-1.5 rounded-full text-sm text-text-muted mb-6">
            <span className="w-1.5 h-1.5 bg-accent rounded-full animate-pulse-dot" />
            Free, no-obligation quote
          </div>
          <h1 className="font-serif text-[clamp(2rem,4vw,3rem)] leading-[1.1] tracking-tight mb-4 font-normal">
            Get a Quote for Your
            <br />
            <em className="text-accent">AI Solution</em>
          </h1>
          <p className="text-text-muted max-w-[480px] mx-auto leading-relaxed">
            Tell us about your business and what you need. We&apos;ll get back to you
            within 24 hours with a tailored proposal.
          </p>
        </div>

        <div className="w-full bg-surface border border-border rounded-2xl p-8 max-sm:p-6">
          <QuoteRequestForm />
        </div>
      </div>
      <Footer />
    </>
  );
}
