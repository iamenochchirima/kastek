import type { WebsiteAppearance } from "./website-appearance-preview";

export type WebsiteAppearanceTemplate = {
  id: string;
  name: string;
  description: string;
  appearance: WebsiteAppearance;
};

/** A template is a complete appearance snapshot. Selecting one fills the editor; later edits are overrides. */
export const websiteAppearanceTemplates: WebsiteAppearanceTemplate[] = [
  {
    id: "light",
    name: "Light",
    description: "Clean and familiar",
    appearance: {
      accent: "#3730a3", title: "Assistant", subtitle: "", theme: "light",
      greeting: "How can we help?", launcherLabel: "Chat", position: "bottom-right",
      quickReplies: [], showBranding: true, avatarUrl: "",
      launcherSize: 56, windowWidth: 390, windowHeight: 620, borderRadius: 16, launcherOffset: 16,
    },
  },
  {
    id: "minimal",
    name: "Minimal",
    description: "Compact and quiet",
    appearance: {
      accent: "#111111", title: "Support", subtitle: "", theme: "light",
      greeting: "Hi there! How can we help?", launcherLabel: "Chat", position: "bottom-right",
      quickReplies: [], showBranding: false, avatarUrl: "",
      launcherSize: 52, windowWidth: 340, windowHeight: 520, borderRadius: 4, launcherOffset: 16,
    },
  },
  {
    id: "business",
    name: "Business",
    description: "Header with a short description",
    appearance: {
      accent: "#7a1218", title: "Assistant", theme: "light",
      subtitle: "Ask us anything: menu, prices, orders, stores, and more.",
      greeting: "Welcome! How can I help today?", launcherLabel: "Chat", position: "bottom-right",
      quickReplies: [], showBranding: true, avatarUrl: "",
      launcherSize: 56, windowWidth: 390, windowHeight: 620, borderRadius: 4, launcherOffset: 16,
    },
  },
  {
    id: "dark",
    name: "Dark",
    description: "Dark surface with a bright accent",
    appearance: {
      accent: "#2fd4a7", title: "Assistant", subtitle: "", theme: "dark",
      greeting: "How can we help?", launcherLabel: "Chat", position: "bottom-right",
      quickReplies: [], showBranding: true, avatarUrl: "",
      launcherSize: 56, windowWidth: 390, windowHeight: 620, borderRadius: 16, launcherOffset: 16,
    },
  },
];
