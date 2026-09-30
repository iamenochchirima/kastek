"use client";

import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/utils";
import type { AgentModel, AgentRuntimeTelemetry } from "@/lib/agent-platform";
import { AgentChatRuntimeBar } from "./agent-chat-runtime-bar";

export function AgentChatSurface({
  children,
  composer,
  header,
  runtime,
  inactiveNotice,
  statusContent,
  error,
  contentRef,
  autoScrollKey,
  contentClassName,
  className,
}: {
  children: ReactNode;
  composer: ReactNode;
  header?: ReactNode;
  runtime?: {
    telemetry: AgentRuntimeTelemetry | null;
    model?: AgentModel;
    detailsOpen: boolean;
    onToggleDetails: () => void;
  };
  inactiveNotice?: ReactNode;
  statusContent?: ReactNode;
  error?: ReactNode;
  contentRef?: RefObject<HTMLDivElement | null>;
  autoScrollKey?: string | number;
  contentClassName?: string;
  className?: string;
}) {
  const internalContentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (autoScrollKey === undefined) return;
    let frame = 0;
    let settleFrame = 0;
    const scrollToBottom = () => {
      const element = internalContentRef.current;
      if (!element) return;
      element.scrollTop = element.scrollHeight;
    };
    frame = window.requestAnimationFrame(() => {
      scrollToBottom();
      settleFrame = window.requestAnimationFrame(scrollToBottom);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(settleFrame);
    };
  }, [autoScrollKey]);

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      {header}
      {runtime ? <AgentChatRuntimeBar {...runtime} /> : null}
      {inactiveNotice}
      <div
        ref={(element) => {
          internalContentRef.current = element;
          if (contentRef) contentRef.current = element;
        }}
        className={cn("min-h-0 flex-1 overflow-y-auto", contentClassName)}
        aria-live="polite"
      >
        {children}
      </div>
      {statusContent}
      {error ? (
        <div className="shrink-0 border-t border-destructive/20 bg-destructive/10 px-5 py-3 text-sm text-destructive" role="alert">
          {error}
        </div>
      ) : null}
      {composer}
    </div>
  );
}
