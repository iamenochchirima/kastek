"use client";

import { useEffect, useState } from "react";

const LINES = [
  {
    lines: ["Build your", "online presence."],
    className: "text-white",
  },
  {
    lines: ["Automate customer", "conversations."],
    className: "text-white",
  },
  {
    lines: ["Grow with smarter", "systems."],
    className: "text-accent",
  },
];

export default function SequentialHeroLines() {
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % LINES.length);
    }, 2600);

    return () => {
      window.clearInterval(interval);
    };
  }, []);

  return (
    <div className="relative mt-6 flex min-h-[8.5rem] w-full items-center justify-center md:min-h-[11rem]">
      {LINES.map((line, index) => {
        const isVisible = activeIndex === index;

        return (
          <h1
            key={line.lines.join(" ")}
            className={`absolute left-1/2 top-1/2 w-full max-w-4xl -translate-x-1/2 -translate-y-1/2 text-center text-4xl font-black uppercase leading-[0.95] tracking-[-0.05em] transition-all duration-700 md:text-6xl ${line.className} ${
              isVisible
                ? "-translate-y-1/2 opacity-100"
                : "pointer-events-none translate-y-0 opacity-0"
            }`}
          >
            <span className="block">{line.lines[0]}</span>
            <span className="block">{line.lines[1]}</span>
          </h1>
        );
      })}
    </div>
  );
}
