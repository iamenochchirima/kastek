import type { ReactNode } from "react";
import { PiArrowLeft } from "react-icons/pi";
import { Button } from "../button.js";

export function AssistantViewHeader({ title, onBack, action }: { title: string; onBack: () => void; action?: ReactNode }) {
  return <div className="flex shrink-0 items-center gap-2 border-b border-border p-4">
    <Button type="button" variant="ghost" size="icon" className="size-8" onClick={onBack} aria-label="Back to chat"><PiArrowLeft className="size-4" aria-hidden="true" /></Button>
    <h3 className="flex-1 text-sm font-semibold">{title}</h3>
    {action}
  </div>;
}

export type AssistantSettingsIdentity = {
  name: string;
  subtitle?: string;
  icon?: ReactNode;
};

export type AssistantSettingsSection = {
  id: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  content: ReactNode;
};

export function AssistantSettingsView({ title = "Settings", onBack, identity, sections, footer }: {
  title?: string;
  onBack: () => void;
  identity?: AssistantSettingsIdentity;
  sections: AssistantSettingsSection[];
  footer?: ReactNode;
}) {
  return <div className="flex min-h-0 flex-1 flex-col">
    <AssistantViewHeader title={title} onBack={onBack} />
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
      {identity ? <section aria-label={`${identity.name} profile`} className="flex items-center gap-3">
        {identity.icon ? <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">{identity.icon}</span> : null}
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{identity.name}</p>{identity.subtitle ? <p className="text-xs text-muted-foreground">{identity.subtitle}</p> : null}</div>
      </section> : null}
      {sections.map(section => <section key={section.id} aria-label={section.title} className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0"><h4 className="text-sm font-medium">{section.title}</h4>{section.description ? <p className="text-xs text-muted-foreground">{section.description}</p> : null}</div>
          {section.action}
        </div>
        {section.content}
      </section>)}
      {footer}
    </div>
  </div>;
}
