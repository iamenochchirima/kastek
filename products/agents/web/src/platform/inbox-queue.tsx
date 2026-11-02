import { HugeiconsIcon } from "@hugeicons/react";
import { Chatting01Icon, Facebook01Icon, Globe02Icon, InstagramIcon, Search01Icon, TelegramIcon, UserIcon, WhatsappIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorMessage, Loading } from "./shell";
import type { InboxConversation } from "./inbox";
import "./inbox-queue.css";

type QueueItem = InboxConversation & { customerName?: string | null; lastMessage?: { body: string; authorKind: string; createdAt: string } | null };

const channels = { website: "Website", whatsapp: "WhatsApp", telegram: "Telegram", facebook: "Messenger", instagram: "Instagram" };
const channelIcons = { website: Globe02Icon, whatsapp: WhatsappIcon, telegram: TelegramIcon, facebook: Facebook01Icon, instagram: InstagramIcon };
const statuses = { automation_active: "Automated", handoff_pending: "Needs a person", human_owned: "With support", resolved: "Resolved" };

export function InboxQueue({ items, selected, search, filtered, error, hasMore, onSearch, onSelect, onRetry, onMore }: {
  items: QueueItem[] | null; selected: string; search: string; filtered: boolean; error: string; hasMore: boolean;
  onSearch(value: string): void; onSelect(id: string): void; onRetry(): void; onMore(): void;
}) {
  return <aside aria-label="Customer conversations" className={`${selected ? "hidden md:block" : ""} inbox-list min-w-0`}>
    <div className="inbox-queue-heading"><h2>Conversations</h2><label className="inbox-queue-search"><HugeiconsIcon icon={Search01Icon} size={17} aria-hidden="true" /><Input aria-label="Search conversations" placeholder="Search conversations" value={search} onChange={event => onSearch(event.target.value)} /></label></div>
    {items && error ? <div className="space-y-2 p-3"><ErrorMessage value={error} /><Button size="sm" variant="outline" onClick={onRetry}>Retry</Button></div> : null}
    {!items ? error ? <div className="space-y-3 p-3"><ErrorMessage value={error} /><Button size="sm" variant="outline" onClick={onRetry}>Retry</Button></div> : <Loading /> : items.length ? <div className="inbox-queue-items">{items.map(item => {
      const customer = item.customerName?.trim();
      const preview = item.lastMessage?.body.trim();
      const displayTime = item.lastMessage?.createdAt ?? item.updatedAt;
      return <button type="button" key={item.id} onClick={() => onSelect(item.id)} aria-pressed={selected === item.id} className={`inbox-conversation ${selected === item.id ? "is-selected" : ""}`}>
        <span className="inbox-queue-avatar" aria-hidden="true">{customer ? customer.split(/\s+/).slice(0, 2).map(part => part[0]).join("").toLocaleUpperCase() : <HugeiconsIcon icon={UserIcon} size={19} />}</span>
        <span className="inbox-conversation-content"><span className="inbox-conversation-title"><span className="truncate">{customer || "Customer"}</span></span>{item.agentName ? <span className="sr-only">Agent {item.agentName}</span> : null}
          <span className="inbox-queue-preview">{preview || (item.lastMessage ? "Message" : "No messages yet")}</span>
          {item.channelAvailable === false ? <span className="inbox-queue-unavailable">Channel unavailable</span> : null}
        </span><span className="inbox-queue-channel" aria-label={channels[item.channel]}><HugeiconsIcon icon={channelIcons[item.channel]} size={18} aria-hidden="true" /></span><span className="inbox-queue-end"><time dateTime={displayTime}>{new Date(displayTime).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time><span className={`inbox-queue-status status-${item.state}`}>{statuses[item.state]}</span></span>
      </button>;
    })}</div> : <p className="inbox-queue-empty">{search.trim() || filtered ? "No matching conversations" : "No customer conversations"}</p>}
    {hasMore ? <Button variant="ghost" className="m-3" onClick={onMore}>Load more conversations</Button> : null}
  </aside>;
}

export function InboxNoSelection() {
  return <div className="inbox-no-selection"><span className="inbox-no-selection-icon"><HugeiconsIcon icon={Chatting01Icon} size={26} aria-hidden="true" /></span><h2>Select a conversation</h2><p>Choose a conversation to view messages.</p></div>;
}
