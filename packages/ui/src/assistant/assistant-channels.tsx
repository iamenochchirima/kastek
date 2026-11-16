import type { ReactNode } from "react";
import { AssistantViewHeader } from "./assistant-settings.js";

export function AssistantChannelsView({ title = "Channels", onBack, children }: { title?: string; onBack: () => void; children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col">
    <AssistantViewHeader title={title} onBack={onBack} />
    <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
  </div>;
}
