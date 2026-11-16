import { PiChatCircle, PiGear, PiLinkSimple, PiPlus, PiSidebarSimple } from "react-icons/pi";
import type { AssistantNavigationItem, AssistantRecentConversation } from "./assistant-types.js";
import { cn } from "../utils.js";

function dateGroup(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Older";
  const today = new Date(), yesterday = new Date(Date.now() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date > new Date(Date.now() - 7 * 86_400_000) ? "Previous 7 days" : "Older";
}

function groupRecents(recents: AssistantRecentConversation[]) {
  const groups = new Map<string, AssistantRecentConversation[]>();
  for (const recent of recents) {
    const group = dateGroup(recent.updatedAt);
    groups.set(group, [...(groups.get(group) ?? []), recent]);
  }
  return ["Today", "Yesterday", "Previous 7 days", "Older"].flatMap(group => groups.has(group) ? [[group, groups.get(group)!] as const] : []);
}

export function AssistantNavigation({ title, expanded, activeView, items, recents, selectedConversationId, onToggle, onSelect, onNewChat, onOpenConversation, onNavigate, ariaLabel }: {
  title: string;
  expanded: boolean;
  activeView: string;
  items: AssistantNavigationItem[];
  recents: AssistantRecentConversation[] | null;
  selectedConversationId: string | null;
  onToggle: () => void;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onOpenConversation: (id: string) => void;
  onNavigate?: () => void;
  ariaLabel?: string;
}) {
  const actionClass = (active = false) =>
    cn("flex h-9 items-center rounded-md text-sm transition-colors hover:bg-muted", expanded ? "w-full gap-2 px-2.5" : "w-9 justify-center", active && "bg-muted text-foreground");
  const choose = (action: () => void) => () => { action(); onNavigate?.(); };
  return <nav aria-label={ariaLabel ?? `${title} navigation`} className={cn("flex shrink-0 flex-col border-r border-border bg-card/30 p-2 transition-[width]", expanded ? "w-56" : "w-14")}>
    <div className={cn("mb-2 flex items-center", expanded ? "justify-between px-1" : "justify-center")}>
      <span className={cn("text-sm font-semibold", !expanded && "sr-only")}>{title}</span>
      <button type="button" className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" onClick={onToggle} aria-label={expanded ? `Collapse ${title} navigation` : `Expand ${title} navigation`}>
        <PiSidebarSimple size={16} aria-hidden="true" className={cn("transition-transform", expanded && "rotate-180")} />
      </button>
    </div>
    <button type="button" className={actionClass()} onClick={choose(onNewChat)}>
      <PiPlus size={16} aria-hidden="true" />
      <span className={cn(!expanded && "sr-only")}>New chat</span>
    </button>
    {items.filter(item => !item.hidden).map(item => <button key={item.id} type="button" aria-current={activeView === item.id ? "page" : undefined} className={actionClass(activeView === item.id)} onClick={choose(() => onSelect(item.id))}>
      {item.icon ?? <PiChatCircle size={16} aria-hidden="true" />}
      <span className={cn(!expanded && "sr-only")}>{item.label}</span>
    </button>)}
    {expanded ? <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
      <p className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Recents</p>
      {recents === null ? null : recents.length === 0 ? <p className="px-2.5 py-2 text-xs text-muted-foreground">No chats yet.</p> : groupRecents(recents).map(([group, rows]) => <div key={group} className="mb-2">
        <p className="px-2.5 py-1 text-[11px] text-muted-foreground">{group}</p>
        {rows.map(recent => <button key={recent.id} type="button" onClick={choose(() => onOpenConversation(recent.id))} aria-current={selectedConversationId === recent.id ? "page" : undefined}
          className={cn("flex h-8 w-full items-center rounded-md px-2.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground", selectedConversationId === recent.id && "bg-muted text-foreground")}>
          <span className="truncate">{recent.title}</span>
        </button>)}
      </div>)}
    </div> : null}
  </nav>;
}

export function assistantNavigationItems(items: AssistantNavigationItem[]) {
  return items.filter(item => !item.hidden);
}

export const defaultAssistantNavigationIcons = {
  chats: <PiChatCircle size={16} aria-hidden="true" />,
  settings: <PiGear size={16} aria-hidden="true" />,
  channels: <PiLinkSimple size={16} aria-hidden="true" />,
};
