import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantChannelsView, AssistantChat, AssistantLauncher, AssistantLibrary, AssistantNavigation, AssistantSettingsView } from "../dist/assistant/index.js";

const noop = () => {};

test("shared assistant navigation exposes the common actions and recents", () => {
  const html = renderToStaticMarkup(createElement(AssistantNavigation, {
    title: "Ask AI", expanded: true, activeView: "settings", selectedConversationId: "conversation-1",
    items: [
      { id: "library", label: "Chats" },
      { id: "settings", label: "Settings" },
      { id: "channels", label: "Channels" },
    ],
    recents: [{ id: "conversation-1", title: "Launch plan", updatedAt: new Date().toISOString() }],
    onToggle: noop, onSelect: noop, onNewChat: noop, onOpenConversation: noop,
  }));
  for (const label of ["New chat", "Chats", "Settings", "Channels", "Recents", "Today", "Launch plan"]) assert.match(html, new RegExp(`>${label}<`), label);
  assert.match(html, /aria-label="Collapse Ask AI navigation"/);
  assert.match(html, /aria-current="page"[^>]*>.*Settings/s);
});

test("collapsed shared navigation keeps labels available to assistive technology", () => {
  const html = renderToStaticMarkup(createElement(AssistantNavigation, {
    title: "Ask AI", expanded: false, activeView: "chat", selectedConversationId: null,
    items: [{ id: "settings", label: "Settings" }], recents: null,
    onToggle: noop, onSelect: noop, onNewChat: noop, onOpenConversation: noop,
  }));
  assert.match(html, /class="[^"]*w-14/);
  assert.match(html, />Settings</);
  assert.doesNotMatch(html, />Recents</);
  assert.match(html, /aria-label="Expand Ask AI navigation"/);
});

test("shared launcher owns the accessible label and drag surface", () => {
  const html = renderToStaticMarkup(createElement(AssistantLauncher, {
    open: false, onOpenChange: noop, label: "Open Ask AI", icon: createElement("span", null, "ask"), storageKey: "test.launcher",
  }));
  assert.match(html, /aria-label="Open Ask AI"/);
  assert.match(html, /title="Open Ask AI"/);
  assert.match(html, />ask</);
  assert.match(html, /assistant-wave/);
  assert.equal(renderToStaticMarkup(createElement(AssistantLauncher, {
    open: true, onOpenChange: noop, label: "Open Ask AI", icon: null, storageKey: "test.launcher",
  })), "");
});

test("shared chat renders turns, details, composer and empty state", () => {
  const html = renderToStaticMarkup(createElement(AssistantChat, {
    scrollKey: "test", turns: [{ id: "turn-1", label: "Turn 1", user: [{ id: "u", role: "user", text: "Hello" }], assistant: [{ id: "a", role: "assistant", text: "Hi" }], details: createElement("p", null, "Task details") }],
    renderAssistant: message => message.text,
    composer: createElement("textarea", { "aria-label": "Message", placeholder: "Message your agent…" }),
  }));
  assert.match(html, /aria-label="Turn 1"/);
  assert.match(html, /Hello/); assert.match(html, /Hi/); assert.match(html, /Task details/); assert.match(html, /Message your agent/);
  const empty = renderToStaticMarkup(createElement(AssistantChat, { scrollKey: "empty", turns: [], renderAssistant: () => null, emptyTitle: "How can I help?" }));
  assert.match(empty, /How can I help\?/);
});

test("shared settings and channels own the section layout", () => {
  const settings = renderToStaticMarkup(createElement(AssistantSettingsView, {
    title: "Ask AI settings", onBack: noop, identity: { name: "Ask AI", subtitle: "Workspace AI · Ready" },
    sections: [{ id: "model", title: "Model", content: createElement("p", null, "Model content") }],
  }));
  assert.match(settings, /Ask AI settings/);
  assert.match(settings, /Model/); assert.match(settings, /Model content/);
  const channels = renderToStaticMarkup(createElement(AssistantChannelsView, { onBack: noop }, createElement("p", null, "Member channels")));
  assert.match(channels, /Channels/); assert.match(channels, /Member channels/);
});

test("shared library owns search, recents and archive controls", () => {
  const html = renderToStaticMarkup(createElement(AssistantLibrary, {
    onBack: noop, search: "", onSearch: noop, items: [{ id: "one", title: "Launch plan", updatedAt: new Date().toISOString() }],
    onOpen: noop, pinnedIds: [], onTogglePin: noop, onArchive: noop, showArchived: false, onToggleArchived: noop, archivedItems: [],
  }));
  assert.match(html, /Conversation library/);
  assert.match(html, /Search conversations/);
  assert.match(html, /Launch plan/);
  assert.match(html, /Archived/);
  assert.match(html, /Archive Launch plan/);
  assert.match(html, /Pin Launch plan/);
});

test("the shared assistant source has no product imports", async () => {
  const source = path => readFile(new URL(`../src/assistant/${path}`, import.meta.url), "utf8");
  for (const file of ["assistant-types.ts", "assistant-navigation.tsx", "assistant-panel.tsx", "assistant-launcher.tsx", "assistant-chat.tsx", "assistant-settings.tsx", "assistant-channels.tsx", "assistant-library.tsx", "index.ts"]) {
    const text = await source(file);
    assert.doesNotMatch(text, /from ["'][^"']*(products\/|@\/|\.\.\/\.\.\/\.\.\/)/, file);
  }
});
