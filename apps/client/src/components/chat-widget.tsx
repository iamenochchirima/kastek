"use client";

import { useEffect, useRef } from "react";

function parseStreamedResponse(raw: string): string {
  try {
    // Try parsing as regular JSON first
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
    if (parsed.output) return parsed.output;
    if (parsed.text) return parsed.text;
    if (parsed.content) return parsed.content;
  } catch {
    // Not valid JSON, try extracting content from streamed format
  }

  // Extract all "content" values from the streamed JSON lines
  const contents: string[] = [];
  const regex = /"type"\s*:\s*"item"\s*,\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let match;
  while ((match = regex.exec(raw)) !== null) {
    contents.push(
      match[1]
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\")
    );
  }

  if (contents.length > 0) {
    return contents.join("");
  }

  // Fallback: return raw
  return raw;
}

export default function ChatWidget() {
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://cdn.jsdelivr.net/npm/@n8n/chat/dist/style.css";
    document.head.appendChild(link);

    const style = document.createElement("style");
    style.textContent = `
      .n8n-chat .chat-input {
        display: flex !important;
        align-items: center !important;
        gap: 8px !important;
        padding: 8px 12px !important;
        border-top: 1px solid var(--theme-chat-input-border) !important;
        background: var(--theme-chat-panel-bg) !important;
      }
      .n8n-chat .chat-input textarea {
        all: unset !important;
        display: block !important;
        flex: 1 !important;
        min-height: 36px !important;
        max-height: 100px !important;
        padding: 8px 12px !important;
        border: 1px solid var(--theme-chat-input-border) !important;
        border-radius: 18px !important;
        font-size: 14px !important;
        line-height: 1.4 !important;
        resize: none !important;
        overflow-y: auto !important;
        background: var(--theme-chat-input-bg) !important;
        color: var(--theme-chat-panel-text) !important;
        box-sizing: border-box !important;
        font-family: inherit !important;
        white-space: pre-wrap !important;
        word-wrap: break-word !important;
      }
      .n8n-chat .chat-input textarea:focus {
        outline: none !important;
        border-color: #4a90e2 !important;
      }
      .n8n-chat .chat-input textarea::placeholder {
        color: var(--theme-chat-placeholder) !important;
      }
      .n8n-chat .chat-input button {
        all: unset !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 36px !important;
        height: 36px !important;
        border-radius: 50% !important;
        background: #4a90e2 !important;
        color: #fff !important;
        cursor: pointer !important;
        flex-shrink: 0 !important;
      }
      .n8n-chat .chat-input button:hover {
        background: #357abd !important;
      }
      .n8n-chat .chat-input button:disabled {
        background: #ccc !important;
        cursor: not-allowed !important;
      }
      .n8n-chat .chat-layout,
      .n8n-chat .chat-window,
      .n8n-chat .chat-body,
      .n8n-chat .chat-header {
        background: var(--theme-chat-panel-bg) !important;
        color: var(--theme-chat-panel-text) !important;
      }
    `;
    document.head.appendChild(style);

    // Intercept fetch to parse streamed responses
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);
      const url = typeof args[0] === "string" ? args[0] : args[0] instanceof Request ? args[0].url : "";

      if (url.includes("/webhook/") && url.includes("/chat")) {
        const clone = response.clone();
        const text = await clone.text();
        const parsed = parseStreamedResponse(text);

        return new Response(JSON.stringify({ output: parsed }), {
          status: response.status,
          statusText: response.statusText,
          headers: { "Content-Type": "application/json" },
        });
      }

      return response;
    };

    const script = document.createElement("script");
    script.type = "module";
    script.textContent = `
      import { createChat } from 'https://cdn.jsdelivr.net/npm/@n8n/chat/dist/chat.bundle.es.js';
      createChat({
        webhookUrl: 'https://primary-production-738c.up.railway.app/webhook/a21d3f79-cfa7-44b1-b0e3-93ab1e51176d/chat',
        webhookConfig: {
          method: 'POST',
          headers: {}
        },
        target: '#n8n-chat',
        mode: 'window',
        chatInputKey: 'chatInput',
        chatSessionKey: 'sessionId',
        loadPreviousSession: false,
        metadata: {},
        showWelcomeScreen: false,
        defaultLanguage: 'en',
        enableStreaming: false,
        initialMessages: [
          'Hi there! 👋',
          "I'm KasiTek's assistant. How can I help you today?"
        ],
        i18n: {
          en: {
            title: 'KasiTek',
            subtitle: 'Ask us anything about our AI solutions.',
            footer: '',
            getStarted: 'New Conversation',
            inputPlaceholder: 'Type your question..',
          },
        },
      });
    `;
    document.body.appendChild(script);
  }, []);

  return <div id="n8n-chat" />;
}
