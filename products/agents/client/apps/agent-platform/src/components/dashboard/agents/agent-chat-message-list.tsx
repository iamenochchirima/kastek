"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReactNode } from "react";
import { Copy, LoaderCircle, Pencil, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AgentMessage } from "@/lib/agent-platform";
import { cn } from "@/lib/utils";
import { AgentAuthorizationAction } from "./agent-authorization-action";
import { AgentMessageMedia, agentMessageHasMedia } from "./agent-message-media";
import { DynamicUiRenderer } from "@/components/dashboard/kasiai/dynamic-ui-renderer";
import type { AgentUiInteraction } from "@/components/dashboard/kasiai/dynamic-ui-renderer";

const markdownComponents: Components = {
  h1: ({ children }) => <h3 className="mt-3 text-base font-semibold first:mt-0">{children}</h3>,
  h2: ({ children }) => <h4 className="mt-3 text-sm font-semibold first:mt-0">{children}</h4>,
  p: ({ children }) => <p className="mt-2 first:mt-0">{children}</p>,
  ul: ({ children }) => <ul className="mt-2 list-disc space-y-1 pl-5 first:mt-0">{children}</ul>,
  ol: ({ children }) => <ol className="mt-2 list-decimal space-y-1 pl-5 first:mt-0">{children}</ol>,
  code: ({ children, className }) => className ? <code className="my-2 block overflow-x-auto rounded-md bg-black/15 p-2 text-xs">{children}</code> : <code className="rounded bg-black/15 px-1 py-0.5 text-[0.85em]">{children}</code>,
  a: ({ children, href }) => /^(https?:|mailto:)/i.test(href ?? "") ? <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2">{children}</a> : <>{children}</>,
  table: ({ children }) => <div className="my-2 overflow-x-auto"><table className="w-full border-collapse text-left text-xs">{children}</table></div>,
  th: ({ children }) => <th className="border border-current/20 px-2 py-1 font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-current/20 px-2 py-1 align-top">{children}</td>,
};

const channelLabels: Record<string, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  discord: "Discord",
};

export function channelLabel(channel: string) {
  return channelLabels[channel.toLowerCase()] ?? `${channel.slice(0, 1).toUpperCase()}${channel.slice(1)}`;
}

export function messageChannel(message: AgentMessage) {
  return (message.source_channel || message.provider || "platform").toLowerCase();
}

export function messageText(message: AgentMessage) {
  if (typeof message.content?.text === "string") return message.content.text;
  if (Array.isArray(message.content?.media) || typeof message.content?.assetId === "string") return "Attachment";
  return JSON.stringify(message.content);
}

export function messageRenderText(message: AgentMessage) {
  if (agentMessageHasMedia(message) && typeof message.content?.text !== "string") return "";
  return messageText(message);
}

export function sortedAgentMessages(messages: AgentMessage[]) {
  return [...messages].sort((left, right) => Number(left.sequence_number) - Number(right.sequence_number));
}

export function AgentChatMessageList({
  messages,
  loading = false,
  emptyState,
  archived = false,
  availableChannels = [],
  channelFilter = "all",
  onChannelFilterChange,
  runStatuses,
  onUiInteraction,
  onCopy,
  onEdit,
  onRetry,
  retryable,
  actionDisabled = false,
  className,
}: {
  messages: AgentMessage[];
  loading?: boolean;
  emptyState?: ReactNode;
  archived?: boolean;
  availableChannels?: string[];
  channelFilter?: string;
  onChannelFilterChange?: (channel: string) => void;
  runStatuses?: Record<string, string>;
  onUiInteraction?: (message: AgentMessage, interaction: AgentUiInteraction) => void | Promise<void>;
  onCopy?: (message: AgentMessage) => void | Promise<void>;
  onEdit?: (message: AgentMessage) => void;
  onRetry?: (message: AgentMessage) => void;
  retryable?: (message: AgentMessage, status?: string) => boolean;
  actionDisabled?: boolean;
  className?: string;
}) {
  const visibleMessages = channelFilter === "all"
    ? messages
    : messages.filter((message) => messageChannel(message) === channelFilter);

  if (loading) {
    return <div className={cn("flex min-h-48 items-center justify-center text-sm text-muted-foreground", className)}><LoaderCircle className="mr-2 size-4 animate-spin" />Loading conversation</div>;
  }

  return (
    <div className={cn("mx-auto w-full max-w-3xl space-y-4", className)}>
      {availableChannels.length && onChannelFilterChange ? (
        <div className="mb-4 flex gap-1 overflow-x-auto">
          {["all", ...availableChannels].map((channel) => (
            <Button key={channel} variant={channelFilter === channel ? "secondary" : "ghost"} size="sm" className="h-7 px-2 text-[11px]" onClick={() => onChannelFilterChange(channel)}>
              {channel === "all" ? "All messages" : channelLabel(channel)}
            </Button>
          ))}
        </div>
      ) : null}
      {visibleMessages.length ? visibleMessages.map((message) => {
        const source = messageChannel(message);
        const delivery = message.direction === "outbound" && message.delivery_status && message.delivery_status !== "local" ? ` · ${message.delivery_status}` : "";
        const runStatus = message.run_id ? runStatuses?.[message.run_id] : undefined;
        const canRetry = retryable?.(message, runStatus) ?? false;
        const canEdit = Boolean(onEdit && source === "platform" && message.direction === "inbound" && !archived);
        const canCopy = Boolean(onCopy && source === "platform" && message.direction === "inbound" && !archived);

        return (
          <div key={message.id} className={cn("group flex", message.direction === "outbound" ? "justify-start" : message.direction === "system" ? "justify-center" : "justify-end")} data-message-id={message.id}>
            <div className={cn("min-w-0 break-words", message.direction === "outbound" ? "w-full" : "max-w-[88%]")}>
              {source !== "platform" ? <div className={cn("mb-1 text-[10px] text-muted-foreground", message.direction === "outbound" ? "text-left" : "text-right")}>{channelLabel(source)}{delivery}</div> : null}
              <div className={cn("text-sm leading-6", message.direction === "outbound" ? "w-full px-0 py-1 text-foreground" : message.direction === "system" ? "rounded-lg border border-border bg-muted/50 px-3.5 py-2.5 text-muted-foreground" : "rounded-2xl rounded-br-sm bg-primary px-3.5 py-2.5 text-primary-foreground", canRetry && "ring-1 ring-destructive/60")}>
                <AgentMessageMedia message={message} />
                {message.direction === "outbound" ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents} skipHtml>{messageRenderText(message)}</ReactMarkdown> : <span className="whitespace-pre-wrap">{messageRenderText(message)}</span>}
                {message.direction === "outbound" && source === "platform" ? <DynamicUiRenderer ui={message.content.ui} onInteraction={!archived && onUiInteraction ? (interaction) => onUiInteraction(message, interaction) : undefined} /> : null}
                <AgentAuthorizationAction message={message} />
              </div>
              {canCopy || canEdit || canRetry ? (
                <div className="pointer-events-none mt-1 flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                  {canCopy ? <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => void onCopy?.(message)} aria-label="Copy message" title="Copy message"><Copy className="h-3.5 w-3.5" /></Button> : null}
                  {canEdit ? <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => onEdit?.(message)} aria-label="Edit and resend message" title="Edit and resend message"><Pencil className="h-3.5 w-3.5" /></Button> : null}
                  {canRetry ? <Button type="button" variant="outline" size="sm" className="h-7 gap-1 px-2 text-[11px] text-destructive" onClick={() => onRetry?.(message)} disabled={actionDisabled} aria-label="Retry message"><RotateCcw className="h-3.5 w-3.5" />Retry</Button> : null}
                </div>
              ) : null}
              {canRetry ? <p className="mt-0.5 text-right text-[10px] text-destructive">Run {runStatus}</p> : null}
            </div>
          </div>
        );
      }) : emptyState ?? <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">No messages yet</div>}
    </div>
  );
}
