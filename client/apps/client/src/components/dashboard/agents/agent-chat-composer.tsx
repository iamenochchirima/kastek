"use client";

import type { RefObject, ReactNode } from "react";
import { Send, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AudioMessageControl } from "@/components/dashboard/kasiai/audio-message-control";
import type { AgentModel, AgentModelProvider } from "@/lib/agent-platform";
import { cn } from "@/lib/utils";
import { AgentModelPicker } from "./agent-model-picker";

export function AgentChatComposer({
  value,
  onChange,
  onSubmit,
  model,
  models = [],
  onModelChange,
  modelDisabled = false,
  disabled = false,
  sending = false,
  onStop,
  onAudioReady,
  onAudioError,
  placeholder = "Message this agent…",
  hint = "Enter to send · Shift+Enter for a new line",
  inputRef,
  leadingContent,
  modelAccessory,
  className,
  ariaLabel = "Message this agent",
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  model?: AgentModel;
  models?: AgentModel[];
  onModelChange?: (model: string, provider: AgentModelProvider) => void;
  modelDisabled?: boolean;
  disabled?: boolean;
  sending?: boolean;
  onStop?: () => void;
  onAudioReady?: (file: File) => void;
  onAudioError?: (message: string) => void;
  placeholder?: string;
  hint?: ReactNode;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  leadingContent?: ReactNode;
  modelAccessory?: ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  const canChooseModel = Boolean(onModelChange && models.length);
  const inputDisabled = disabled || sending;

  return (
    <form
      className={cn("shrink-0 border-t border-border bg-card p-3", className)}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="rounded-2xl border border-border bg-background p-2 shadow-sm focus-within:border-primary/50">
        {leadingContent}
        {canChooseModel ? (
          <div className="mb-1 flex items-center justify-between gap-2 px-1">
            <AgentModelPicker
              model={model}
              models={models}
              disabled={modelDisabled || inputDisabled}
              compact
              menuPlacement="above"
              ariaLabel="Choose this chat's model"
              onSelect={(selectedModel, provider) => onModelChange?.(selectedModel, provider)}
            />
            {modelAccessory}
          </div>
        ) : null}
        <textarea
          ref={inputRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSubmit();
            }
          }}
          disabled={inputDisabled}
          rows={2}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className="min-h-[52px] w-full resize-none border-0 bg-transparent px-1 py-1 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="flex min-w-0 items-center gap-1">
            {onAudioReady && onAudioError ? (
              <AudioMessageControl
                disabled={inputDisabled}
                onAudioReady={onAudioReady}
                onError={onAudioError}
              />
            ) : null}
            {hint ? (
              <span className="hidden truncate text-[10px] text-muted-foreground sm:inline">
                {hint}
              </span>
            ) : null}
          </div>
          {sending && onStop ? (
            <Button type="button" variant="outline" size="sm" onClick={onStop}>
              <Square className="mr-1.5 size-3.5" />
              Stop
            </Button>
          ) : (
            <Button
              type="submit"
              size="sm"
              disabled={inputDisabled || !value.trim()}
            >
              Send
              <Send className="ml-1.5 size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}
