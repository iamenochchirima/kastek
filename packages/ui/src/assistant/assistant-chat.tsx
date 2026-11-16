import type { ReactNode } from "react";
import { PiChatCircle } from "react-icons/pi";
import { AgentComposer, AgentConversationScroll, AgentMessage } from "../agent.js";
import { Button } from "../button.js";
import { Skeleton } from "../skeleton.js";
import type { AssistantChatProps } from "./assistant-types.js";
import { cn } from "../utils.js";

export function AssistantChat({ className, messagesClassName, scrollKey, loading = false, loadingContent, leading, historyAction, empty, emptyTitle = "How can I help?", emptyDescription, emptyIcon, turns, extra, renderAssistant, renderSources, stream, status, error, composer }: AssistantChatProps) {
  const isEmpty = empty ?? (!loading && turns.length === 0);
  return <div className={cn("assistant-chat flex h-full min-h-0 min-w-0 flex-col bg-background", className)}>
    {leading}
    <AgentConversationScroll className={messagesClassName} resetKey={scrollKey}>
      {loading ? loadingContent ?? <div className="space-y-4" role="status" aria-label="Loading conversation"><Skeleton className="ml-auto h-16 w-2/3" /><Skeleton className="h-5 w-5/6" /><Skeleton className="h-5 w-2/3" /></div> : <>
        {historyAction ? <div className="text-center">{historyAction}</div> : null}
        {isEmpty ? <div className="assistant-chat-empty flex min-h-44 flex-col items-center justify-center gap-2 py-12 text-center">
          <span aria-hidden="true" className="grid size-10 place-items-center rounded-full bg-primary/10 text-primary">{emptyIcon ?? <PiChatCircle className="size-5" />}</span>
          <h3 className="text-base font-medium">{emptyTitle}</h3>
          {emptyDescription ? <p className="max-w-sm text-sm text-muted-foreground">{emptyDescription}</p> : null}
        </div> : null}
        {turns.map((turn, index) => <article key={turn.id} aria-label={turn.label ?? `Turn ${index + 1}`} className="space-y-4">
          {turn.user.map(message => <AgentMessage key={message.id} id={message.id} role="user" createdAt={message.createdAt} text={message.text} />)}
          {turn.details}
          {turn.assistant.map(message => <AgentMessage key={message.id} id={message.id} role="assistant" createdAt={message.createdAt}>{renderAssistant(message)}{renderSources && message.sources?.length ? renderSources(message.sources) : null}</AgentMessage>)}
        </article>)}
        {extra}
      </>}
    </AgentConversationScroll>
    {stream ? <div className="assistant-chat-stream flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-4 py-2 text-sm">
      {stream.label ? <p role="status" className="min-w-0 flex-1 text-xs text-muted-foreground">{stream.label}</p> : null}
      {stream.error ? <p role="alert" className="min-w-0 flex-1 text-sm text-destructive">{stream.error}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        {stream.actions}
        {stream.onRetry ? <Button type="button" variant="outline" size="sm" disabled={stream.retryDisabled} onClick={stream.onRetry}>{stream.retryLabel ?? "Retry"}</Button> : null}
        {stream.onStop ? <Button type="button" variant="outline" size="sm" disabled={stream.stopDisabled} onClick={stream.onStop}>{stream.stopLabel ?? "Stop"}</Button> : null}
      </div>
    </div> : null}
    {status}
    {error}
    {composer}
  </div>;
}

export function AssistantChatComposer(props: React.ComponentProps<typeof AgentComposer>) {
  return <AgentComposer {...props} className={cn("chat-composer", props.className)} />;
}
