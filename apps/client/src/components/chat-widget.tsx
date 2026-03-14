"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { MessageCircle, SendHorizontal, Sparkles, X } from "lucide-react";

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
};

const storageKey = "kasitek-chat-session-id";
const initialMessages: ChatMessage[] = [
  {
    id: "welcome-1",
    role: "assistant",
    text: "Hi there. I'm KasiTek's assistant.",
  },
  {
    id: "welcome-2",
    role: "assistant",
    text: "Ask me about AI agents, automation systems, pricing, campaigns, or the right setup for your business.",
  },
];

function formatMessage(text: string) {
  const cleaned = text.replace(/\*\*/g, "").replace(/(^|[\s(])\*(.+?)\*/g, "$1$2");
  const parts = cleaned.split(/(\[[^\]]+\]\([^)]+\))/g);

  return parts.map((part, index) => {
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      return (
        <a
          key={`${part}-${index}`}
          href={linkMatch[2]}
          target="_blank"
          rel="noreferrer"
          className="text-primary underline decoration-primary/40 underline-offset-4 transition hover:decoration-primary"
        >
          {linkMatch[1]}
        </a>
      );
    }

    return <span key={`${part}-${index}`}>{part}</span>;
  });
}

export default function ChatWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState(initialMessages);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionIdRef = useRef<string>("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const existingSession =
      typeof window !== "undefined" ? window.localStorage.getItem(storageKey) : null;
    if (existingSession) {
      sessionIdRef.current = existingSession;
      return;
    }

    const created = crypto.randomUUID();
    sessionIdRef.current = created;
    window.localStorage.setItem(storageKey, created);
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages, isSending, error]);

  async function handleSend() {
    const message = input.trim();
    if (!message || isSending) return;

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      text: message,
    };

    setMessages((current) => [...current, userMessage]);
    setInput("");
    setIsSending(true);
    setError(null);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message,
          sessionId: sessionIdRef.current,
          metadata: {
            source: "custom-chat-widget",
            pathname: typeof window !== "undefined" ? window.location.pathname : "/",
          },
        }),
      });

      const data = (await response.json()) as {
        sessionId?: string;
        reply?: string;
        error?: string;
        details?: string;
      };

      if (data.sessionId && data.sessionId !== sessionIdRef.current) {
        sessionIdRef.current = data.sessionId;
        window.localStorage.setItem(storageKey, data.sessionId);
      }

      const reply = data.reply?.trim();

      if (!response.ok || !reply) {
        throw new Error(data.details || data.error || "The assistant did not return a reply.");
      }

      setMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          text: reply,
        },
      ]);
    } catch (caughtError) {
      const messageText =
        caughtError instanceof Error
          ? caughtError.message
          : "Something went wrong while contacting the assistant.";
      setError(messageText);
    } finally {
      setIsSending(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  }

  return (
    <div className="fixed bottom-28 right-3 z-[2147483645] w-[calc(100vw-24px)] max-w-[360px] sm:bottom-32 sm:right-5 sm:w-[360px]">
      {isOpen ? (
        <div className="relative">
          <div className="absolute inset-x-8 bottom-[-26px] -z-30 h-16 rounded-full bg-black/70 blur-2xl" />
          <div className="absolute inset-x-10 bottom-[-38px] -z-20 h-20 rounded-full bg-black/55 blur-3xl" />
          <div className="absolute inset-[-16px] -z-10 rounded-[30px] bg-[radial-gradient(circle_at_top,rgba(232,160,32,0.22),transparent_32%),radial-gradient(circle_at_left,rgba(255,255,255,0.1),transparent_30%),radial-gradient(circle_at_bottom_right,rgba(16,185,129,0.14),transparent_26%)] blur-2xl" />
          <div className="flex h-[560px] max-h-[calc(100vh-150px)] flex-col overflow-hidden rounded-[22px] border border-white/18 bg-[#080808]/95 shadow-[0_18px_32px_rgba(0,0,0,0.32),0_42px_120px_rgba(0,0,0,0.72),0_0_0_1px_rgba(255,255,255,0.05)] backdrop-blur-xl sm:h-[600px]">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(232,160,32,0.14),transparent_38%),radial-gradient(circle_at_bottom_right,rgba(16,185,129,0.1),transparent_28%)]" />
            <div className="absolute inset-0 ring-1 ring-white/6" />
            <div className="absolute inset-x-6 top-0 h-px bg-white/20 blur-[1px]" />

            <div className="relative border-b border-white/10 px-5 py-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-2 shadow-[0_0_24px_rgba(232,160,32,0.12)]">
                    <Image
                      src="/logo.png"
                      alt="KasiTek"
                      width={28}
                      height={28}
                      className="h-7 w-7 rounded-md object-contain"
                    />
                  </div>
                  <div>
                    <div className="landing-font-display text-[1.7rem] leading-none tracking-[0.08em] text-white">
                      KasiTek
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-white/55">
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_12px_rgba(232,160,32,0.85)]" />
                      AI assistant
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">
                    <Sparkles className="h-3 w-3" />
                    live
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsOpen(false)}
                    className="flex h-9 w-9 items-center justify-center rounded-full border border-white/12 bg-white/6 text-white/72 transition hover:bg-white/10 hover:text-white"
                    aria-label="Close chat"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>

            <div ref={scrollRef} className="relative flex-1 space-y-4 overflow-y-auto px-4 py-4 whatsapp-scroll">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[88%] whitespace-pre-wrap rounded-[22px] px-4 py-3 text-[13px] leading-6 shadow-[0_14px_40px_rgba(0,0,0,0.18)] ${
                      message.role === "user"
                        ? "rounded-br-md border border-primary/20 bg-primary text-primary-foreground"
                        : "rounded-bl-md border border-white/10 bg-white/[0.06] text-white/82"
                    }`}
                  >
                    {formatMessage(message.text)}
                  </div>
                </div>
              ))}

              {isSending ? (
                <div className="flex justify-start">
                  <div className="rounded-[22px] rounded-bl-md border border-primary/20 bg-[linear-gradient(180deg,rgba(232,160,32,0.16),rgba(255,255,255,0.05))] px-4 py-3 text-white/72 shadow-[0_14px_40px_rgba(0,0,0,0.18)]">
                    <div className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 animate-[typing-bounce_1s_infinite] rounded-full bg-[#f6b93b] shadow-[0_0_16px_rgba(246,185,59,0.8)]" />
                      <span className="h-2.5 w-2.5 animate-[typing-bounce_1s_0.15s_infinite] rounded-full bg-[#f3a72a] shadow-[0_0_16px_rgba(243,167,42,0.7)]" />
                      <span className="h-2.5 w-2.5 animate-[typing-bounce_1s_0.3s_infinite] rounded-full bg-[#ef9618] shadow-[0_0_16px_rgba(239,150,24,0.6)]" />
                    </div>
                  </div>
                </div>
              ) : null}

              {error ? (
                <div className="rounded-[18px] border border-red-400/20 bg-red-500/10 px-4 py-3 text-[12px] leading-5 text-red-100">
                  {error}
                </div>
              ) : null}
            </div>

            <div className="relative border-t border-white/10 p-4">
              <div className="flex items-end gap-3 rounded-[20px] border border-white/10 bg-white/[0.04] px-3 py-3">
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={handleKeyDown}
                  rows={1}
                  placeholder="Ask your question"
                  className="chat-widget-textarea max-h-32 min-h-[44px] flex-1 resize-none overflow-y-auto bg-transparent px-1 py-2 text-sm text-white outline-none placeholder:text-white/35"
                />
                <button
                  type="button"
                  onClick={() => void handleSend()}
                  disabled={isSending || input.trim().length === 0}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_0_26px_rgba(232,160,32,0.28)] transition enabled:hover:scale-[1.03] disabled:cursor-not-allowed disabled:opacity-45"
                  aria-label="Send message"
                >
                  <SendHorizontal className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setIsOpen(true)}
            className="group flex items-center gap-3 rounded-[18px] border border-white/16 bg-[#090909]/92 px-4 py-3 text-left shadow-[0_20px_55px_rgba(0,0,0,0.5)] backdrop-blur-xl transition hover:-translate-y-0.5 hover:border-white/24"
            aria-label="Open chat"
          >
            <div className="flex h-11 w-11 items-center justify-center rounded-[14px] border border-primary/20 bg-primary text-primary-foreground shadow-[0_0_24px_rgba(232,160,32,0.28)]">
              <MessageCircle className="h-5 w-5" />
            </div>
            <div>
              <div className="landing-font-display text-[1.35rem] leading-none tracking-[0.08em] text-white">
                KasiTek
              </div>
              <div className="mt-1 text-[11px] font-medium uppercase tracking-[0.16em] text-white/52">
                Open assistant
              </div>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}
