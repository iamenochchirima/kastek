import "./agent-avatar.css";

export const agentAvatarOptions = [
  { id: "atlas", label: "Atlas", emoji: "🤖", tone: "#4c8dff" },
  { id: "scout", label: "Scout", emoji: "🦊", tone: "#f58c3b" },
  { id: "muse", label: "Muse", emoji: "👾", tone: "#a06bff" },
  { id: "orbit", label: "Orbit", emoji: "🐙", tone: "#f0639b" },
  { id: "nova", label: "Nova", emoji: "🦉", tone: "#e7a11c" },
  { id: "pixel", label: "Pixel", emoji: "🐧", tone: "#2fb6a6" },
  { id: "echo", label: "Echo", emoji: "🐳", tone: "#3ba7e0" },
  { id: "ember", label: "Ember", emoji: "🔥", tone: "#f06a4d" },
  { id: "bolt", label: "Bolt", emoji: "⚡", tone: "#d9b514" },
  { id: "moss", label: "Moss", emoji: "🐢", tone: "#5aa861" },
] as const;

export type AgentAvatarId = (typeof agentAvatarOptions)[number]["id"];

export const defaultAgentAvatar: AgentAvatarId = "atlas";

export function agentAvatar(id?: string | null) {
  return agentAvatarOptions.find(option => option.id === id) ?? agentAvatarOptions[0];
}

export function randomAgentAvatarId(): AgentAvatarId {
  return agentAvatarOptions[Math.floor(Math.random() * agentAvatarOptions.length)]!.id;
}

export function AgentAvatar({ id, size = 44, className = "" }: { id?: string | null; size?: number; className?: string }) {
  const option = agentAvatar(id);
  return <span className={`agent-avatar-tile ${className}`} aria-hidden="true" data-avatar={option.id}
    style={{ width: size, height: size, fontSize: Math.round(size * 0.5), ["--avatar-tone" as string]: option.tone }}>{option.emoji}</span>;
}
