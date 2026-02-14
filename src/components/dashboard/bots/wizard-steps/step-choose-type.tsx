"use client";

interface StepChooseTypeProps {
  selected: string;
  onSelect: (type: string) => void;
}

const botTypes = [
  {
    id: "starter",
    name: "Starter",
    description: "Menu-driven chatbot with structured conversation flows",
    tags: ["Decision tree", "Quick replies", "Menu options", "Semi-automated"],
    note: "Best for businesses with predictable customer queries",
  },
  {
    id: "growth",
    name: "Growth",
    description: "AI-powered chatbot that understands natural language",
    tags: ["AI responses", "Natural language", "Auto-learning", "Fully automated"],
    note: "Best for businesses wanting intelligent, adaptive conversations",
  },
];

export default function StepChooseType({ selected, onSelect }: StepChooseTypeProps) {
  return (
    <div>
      <h2 className="mb-2 font-serif text-2xl">Choose your bot type</h2>
      <p className="mb-6 text-sm text-text-muted">
        Select the type of WhatsApp chatbot that fits your business needs.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        {botTypes.map((bot) => (
          <button
            key={bot.id}
            onClick={() => onSelect(bot.id)}
            className={`group cursor-pointer rounded-xl border-2 p-6 text-left transition-all ${
              selected === bot.id
                ? "border-accent bg-accent/5"
                : "border-border hover:border-border-light"
            }`}
          >
            <h3
              className={`mb-2 text-lg font-semibold ${
                selected === bot.id ? "text-accent" : "text-text"
              }`}
            >
              {bot.name}
            </h3>
            <p className="mb-4 text-sm text-text-muted">{bot.description}</p>
            <div className="mb-4 flex flex-wrap gap-2">
              {bot.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full bg-surface-2 px-2.5 py-1 text-xs text-text-muted"
                >
                  {tag}
                </span>
              ))}
            </div>
            <p className="text-xs text-text-dim">{bot.note}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
