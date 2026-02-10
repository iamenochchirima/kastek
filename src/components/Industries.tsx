const industries = [
  { icon: "🚛", name: "Trucking & Fleet" },
  { icon: "🏠", name: "Property Management" },
  { icon: "🔧", name: "Auto Repair & Dealers" },
  { icon: "⚕️", name: "Medical & Dental" },
  { icon: "⚖️", name: "Law Firms" },
  { icon: "🏗️", name: "Construction" },
  { icon: "🏪", name: "Retail & E-commerce" },
  { icon: "🍽️", name: "Restaurants & Hospitality" },
  { icon: "🏋️", name: "Gyms & Fitness" },
  { icon: "🧹", name: "Home Services" },
  { icon: "📦", name: "Logistics & Distribution" },
  { icon: "🏨", name: "Hotels & Guest Houses" },
  { icon: "📞", name: "Call Centers & BPOs" },
  { icon: "🛡️", name: "Insurance Agencies" },
  { icon: "🏡", name: "Real Estate Agencies" },
  { icon: "💇", name: "Salons & Spas" },
  { icon: "💰", name: "Accounting & Finance" },
  { icon: "👥", name: "Recruitment & Staffing" },
  { icon: "🐾", name: "Veterinary Clinics" },
  { icon: "🎓", name: "Education & Training" },
  { icon: "➕", name: "And more..." },
];

export default function Industries() {
  return (
    <section id="industries" className="py-24 px-8 max-w-[1100px] mx-auto border-t border-border max-sm:py-16 max-sm:px-6">
      <div className="text-xs uppercase tracking-[0.15em] text-accent mb-4 font-semibold">
        Industries
      </div>
      <h2 className="font-serif text-[clamp(2rem,4vw,3rem)] tracking-tight mb-4 font-normal">
        Built for businesses like yours
      </h2>
      <p className="text-text-muted max-w-[550px] mb-14 text-lg leading-relaxed">
        Whether you run a fleet or a medical practice, if your team spends hours
        on calls, messages, and admin, we can help.
      </p>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
        {industries.map((industry) => (
          <div
            key={industry.name}
            className="flex items-center gap-2 px-3 py-3 bg-surface border border-border rounded-lg text-xs text-text-muted transition-all hover:border-border-light hover:text-text"
          >
            <span className="text-base shrink-0">{industry.icon}</span>
            {industry.name}
          </div>
        ))}
      </div>
    </section>
  );
}
