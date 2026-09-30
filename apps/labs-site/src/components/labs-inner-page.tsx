import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";

type InnerHeroProps = {
  title: ReactNode;
  introduction: string;
  context?: string;
  compact?: boolean;
  action?: {
    label: string;
    href: string;
  };
};

export function InnerHero({
  title,
  introduction,
  context,
  compact = false,
  action,
}: InnerHeroProps) {
  return (
    <header className={`inner-hero${compact ? " is-compact" : ""}`}>
      <div className="inner-hero-title">
        {context ? <p>{context}</p> : null}
        <h1>{title}</h1>
      </div>
      <div className="inner-hero-intro">
        <p>{introduction}</p>
        {action ? (
          <a className="button button-dark" href={action.href}>
            {action.label}
            <ArrowUpRight aria-hidden="true" />
          </a>
        ) : null}
      </div>
    </header>
  );
}

export function ContactPanel({
  title = "Tell us what you need to put into operation.",
  subject = "Project enquiry",
}: {
  title?: string;
  subject?: string;
}) {
  return (
    <section className="inner-contact">
      <div className="inner-contact-copy">
        <p>New work</p>
        <h2>{title}</h2>
      </div>
      <div className="inner-contact-action">
        <p>Tell us what you&apos;re working on and where you need help.</p>
        <Link
          className="button button-acid"
          href={`/contact?subject=${encodeURIComponent(subject)}`}
        >
          Start a conversation
          <ArrowUpRight aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
}

export type DocumentSection = {
  title: string;
  paragraphs: ReactNode[];
};

export function DocumentBody({
  sections,
}: {
  sections: DocumentSection[];
}) {
  return (
    <div className="document-layout">
      <aside className="document-index" aria-label="On this page">
        <p>On this page</p>
        {sections.map((section) => (
          <a key={section.title} href={`#${toSectionId(section.title)}`}>
            {section.title}
          </a>
        ))}
      </aside>
      <div className="document-content">
        {sections.map((section) => (
          <section key={section.title} id={toSectionId(section.title)}>
            <h2>{section.title}</h2>
            <div>
              {section.paragraphs.map((paragraph, index) => (
                <p key={`${section.title}-${index}`}>{paragraph}</p>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function toSectionId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
