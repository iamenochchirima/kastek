import type { ReactNode } from "react";
import { PiArchive, PiMagnifyingGlass, PiPlus, PiPushPin, PiPushPinFill } from "react-icons/pi";
import { Button } from "../button.js";
import { Input } from "../input.js";
import { AssistantViewHeader } from "./assistant-settings.js";
import { cn } from "../utils.js";

export type AssistantLibraryItem = {
  id: string;
  title: string;
  updatedAt: string;
};

export type AssistantLibraryProps = {
  title?: string;
  onBack: () => void;
  onNew?: () => void;
  search: string;
  onSearch: (value: string) => void;
  searchPlaceholder?: string;
  loading?: boolean;
  error?: ReactNode;
  onRetry?: () => void;
  items: AssistantLibraryItem[] | null;
  selectedId?: string | null;
  onOpen: (id: string) => void;
  pinnedIds?: string[];
  onTogglePin?: (id: string) => void;
  onArchive?: (id: string) => void;
  archivedItems?: AssistantLibraryItem[] | null;
  showArchived?: boolean;
  onToggleArchived?: () => void;
  onRestore?: (id: string) => void;
  busyId?: string | null;
  emptyLabel?: string;
  noResultsLabel?: string;
  loadMore?: ReactNode;
  ariaLabel?: string;
};

function dateGroup(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Older";
  const today = new Date(), yesterday = new Date(Date.now() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date > new Date(Date.now() - 7 * 86_400_000) ? "Previous 7 days" : "Older";
}

function groupItems(items: AssistantLibraryItem[]) {
  const groups = new Map<string, AssistantLibraryItem[]>();
  for (const item of items) groups.set(dateGroup(item.updatedAt), [...(groups.get(dateGroup(item.updatedAt)) ?? []), item]);
  return ["Today", "Yesterday", "Previous 7 days", "Older"].flatMap(label => groups.has(label) ? [[label, groups.get(label)!] as const] : []);
}

export function AssistantLibrary({ title = "Conversations", onBack, onNew, search, onSearch, searchPlaceholder = "Search chats", loading = false, error, onRetry, items, selectedId, onOpen, pinnedIds = [], onTogglePin, onArchive, archivedItems, showArchived = false, onToggleArchived, onRestore, busyId, emptyLabel = "No chats yet.", noResultsLabel = "No conversations found.", loadMore, ariaLabel = "Conversation library" }: AssistantLibraryProps) {
  const pinned = new Set(pinnedIds);
  const grouped = groupItems(items ?? []);
  const empty = !loading && items !== null && items.length === 0;
  return <div className="flex min-h-0 flex-1 flex-col" role="region" aria-label={ariaLabel}>
    <AssistantViewHeader title={title} onBack={onBack} action={onNew ? <Button size="sm" onClick={onNew}><PiPlus size={14} aria-hidden="true" />New chat</Button> : undefined} />
    <div className="flex shrink-0 items-center gap-2 border-b border-border p-3">
      <label className="relative min-w-0 flex-1">
        <PiMagnifyingGlass size={15} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input aria-label="Search conversations" placeholder={searchPlaceholder} value={search} onChange={event => onSearch(event.target.value)} className="pl-8" />
      </label>
      {onToggleArchived ? <Button type="button" size="sm" variant={showArchived ? "secondary" : "ghost"} onClick={onToggleArchived} aria-pressed={showArchived}>
        <PiArchive size={15} aria-hidden="true" />{showArchived ? "Hide archived" : "Archived"}
      </Button> : null}
    </div>
    {error ? <div className="shrink-0 px-4 pt-2" role="alert"><p className="text-sm text-destructive">{error}</p>{onRetry ? <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onRetry}>Retry conversations</Button> : null}</div> : null}
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {showArchived ? <section>
        <h4 className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">Archived</h4>
        {archivedItems === null || archivedItems === undefined ? <p role="status" className="px-2 py-2 text-sm text-muted-foreground">Loading archived chats…</p> :
          !archivedItems.length ? <p className="px-2 py-8 text-center text-sm text-muted-foreground">No archived chats.</p> :
          archivedItems.map(item => <div key={item.id} className="flex items-center gap-1 rounded-lg px-2 py-2 text-sm text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            <Button variant="ghost" size="sm" className="h-7 shrink-0 text-[11px]" disabled={busyId === item.id} onClick={() => onRestore?.(item.id)}>Restore</Button>
          </div>)}
      </section> : <>
        {loading || items === null ? <p role="status" className="px-2 py-8 text-center text-sm text-muted-foreground">Loading chats…</p> : null}
        {empty ? <p className="px-2 py-8 text-center text-sm text-muted-foreground">{search.trim() ? noResultsLabel : emptyLabel}</p> : null}
        {grouped.map(([label, rows]) => <section key={label} className="mb-5">
          <h4 className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">{label}</h4>
          {rows.map(item => <div key={item.id} className={cn("group flex items-center gap-1 rounded-lg px-2 py-1.5", selectedId === item.id ? "bg-muted" : "hover:bg-muted/60")}>
            {onTogglePin ? <button type="button" onClick={() => onTogglePin(item.id)} aria-label={pinned.has(item.id) ? `Unpin ${item.title}` : `Pin ${item.title}`} title={pinned.has(item.id) ? "Unpin" : "Pin"}
              className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
              {pinned.has(item.id) ? <PiPushPinFill size={14} aria-hidden="true" /> : <PiPushPin size={14} aria-hidden="true" />}
            </button> : null}
            <button type="button" onClick={() => onOpen(item.id)} className="min-w-0 flex-1 text-left" title={item.title}>
              <span className="block truncate text-sm font-medium">{pinned.has(item.id) ? "• " : ""}{item.title}</span>
              <span className="block truncate text-[11px] text-muted-foreground">{new Date(item.updatedAt).toLocaleString()}</span>
            </button>
            {onArchive ? <Button type="button" size="icon" variant="ghost" className="size-7 shrink-0 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100" disabled={busyId === item.id}
              onClick={() => onArchive(item.id)} aria-label={`Archive ${item.title}`} title="Archive"><PiArchive size={14} aria-hidden="true" /></Button> : null}
          </div>)}
        </section>)}
        {loadMore}
      </>}
    </div>
  </div>;
}
