const faqs = [
  {
    question: "How long does it take to get set up?",
    answer:
      "Most solutions are live in under a week. After you request a quote, we'll get back to you within 24 hours with a proposal. The typical build time is 2 to 4 business days.",
  },
  {
    question: "Do I need any technical knowledge?",
    answer:
      "Not at all. We handle everything from setup to integration. You just tell us about your business and we take care of the rest.",
  },
  {
    question: "What platforms do you integrate with?",
    answer:
      "WhatsApp, your website, CRMs like HubSpot and Zoho, Google Calendar, Xero, QuickBooks, and many more. If you use it, we can likely connect to it.",
  },
  {
    question: "What happens if the AI can't answer a question?",
    answer:
      "The AI gracefully hands over to a human. You'll get notified immediately so you or your team can step in. No customer is ever left hanging.",
  },
  {
    question: "Is there a long-term contract?",
    answer:
      "No. Our plans are month-to-month. You can cancel anytime, though most clients stay because the results speak for themselves.",
  },
  {
    question: "How does pricing work?",
    answer:
      "You pay a once-off setup fee that covers building, testing, and launching your solution. After that, there's a small monthly fee starting from R300/mo that covers hosting, maintenance, and support.",
  },
  {
    question: "Can I customise what the AI says and does?",
    answer:
      "Absolutely. Every solution is tailored to your business. You define the tone, the responses, the workflows. We build it to match how you actually operate.",
  },
  {
    question: "What if I just want to explore my options?",
    answer:
      "Just request a free quote or send us a message on WhatsApp. There's zero obligation — we'll help you understand where AI can help your business.",
  },
];

export default function FAQ() {
  return (
    <section
      id="faq"
      className="py-24 px-8 max-w-[1100px] mx-auto border-t border-border max-sm:py-16 max-sm:px-6"
    >
      <div className="text-xs uppercase tracking-[0.15em] text-accent mb-4 font-semibold">
        FAQ
      </div>
      <h2 className="font-serif text-[clamp(2rem,4vw,3rem)] tracking-tight mb-4 font-normal">
        Frequently asked questions
      </h2>
      <p className="text-text-muted max-w-[550px] mb-14 text-lg leading-relaxed">
        Got questions? We&apos;ve got answers. If you don&apos;t see yours here, just reach out on
        WhatsApp.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-border border border-border rounded-2xl overflow-hidden">
        {faqs.map((faq) => (
          <div
            key={faq.question}
            className="bg-surface p-7 transition-all hover:bg-surface-2"
          >
            <h3 className="text-sm font-semibold mb-2">{faq.question}</h3>
            <p className="text-sm text-text-muted leading-relaxed">
              {faq.answer}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
