"use client";

interface SectionDividerProps {
  id: string;
  tag: string;
  tagColor: string;
  title: string;
  description: string;
}

export default function SectionDivider({ id, tag, tagColor, title, description }: SectionDividerProps) {
  return (
    <div id={id} className="text-center mb-12">
      <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold mb-3 ${tagColor}`}>{tag}</span>
      <h2 className="text-3xl md:text-4xl font-bold text-gray-900 mb-4 leading-tight">{title}</h2>
      <p className="text-gray-500 max-w-xl mx-auto text-base leading-relaxed">{description}</p>
    </div>
  );
}
