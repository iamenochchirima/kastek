import { HugeiconsIcon } from "@hugeicons/react";
import { Robot01Icon, UserIcon } from "@hugeicons/core-free-icons";
import type { CustomerMessage } from "./inbox";
import "./inbox-thread.css";

const deliveryLabels = {pending:"Pending",sending:"Sending",accepted:"Provider accepted",sent:"Sent",delivered:"Delivered",read:"Read",failed:"Failed",unknown:"Outcome unknown",suppressed:"Suppressed"};

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toLocaleUpperCase();
}

export function InboxMessages({ messages, customerName, agentName, members }: {
  messages: CustomerMessage[]; customerName?: string | null; agentName?: string; members: { id: string; displayName: string }[];
}) {
  return <div className="inbox-messages" role="log" aria-label="Conversation messages" aria-live="polite">{messages.map(item => {
    const isCustomer = item.authorKind === "visitor";
    const name = item.displayKind === "system" ? "System" : isCustomer ? customerName || "Customer" : item.authorKind === "assistant" ? agentName || "Assistant" : members.find(member => member.id === item.authorAccountId)?.displayName || "Support";
    const initial = isCustomer ? customerName && initials(customerName) : item.authorKind === "human" && name !== "Support" ? initials(name) : "";
    return <article key={item.id} className={`inbox-message inbox-message--${item.authorKind}`}>
      <span className="inbox-message-avatar" aria-hidden="true">{initial || <HugeiconsIcon icon={item.authorKind === "assistant" ? Robot01Icon : UserIcon} size={18} />}</span>
      <div className="inbox-message-content"><div className="inbox-message-meta"><span>{name}</span><time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}>{new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>
        <div className="inbox-message-bubble"><p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{item.body}</p>{item.channelFacts?.attachments.length ? <ul className="mt-2 space-y-1 text-xs" aria-label="Message attachments">{item.channelFacts.attachments.map(attachment => <li key={attachment.index} className="break-words">{attachment.fileName ?? `${attachment.kind} attachment`}</li>)}</ul> : null}</div>
        {item.deliveries?.length ? <div aria-label="Delivery status" className="inbox-message-delivery">{item.deliveries.map(delivery => <span key={delivery.id}>{item.deliveries!.length > 1 ? `Part ${delivery.segment + 1}: ` : ""}{deliveryLabels[delivery.state]}{delivery.state === "unknown" ? " · Check provider before retrying" : ""}</span>)}</div> : null}
      </div>
    </article>;
  })}</div>;
}
