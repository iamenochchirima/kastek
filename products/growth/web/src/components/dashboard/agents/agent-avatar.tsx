export const agentAvatars = [
  { id: "atlas", sheet: "primary", x: 0, y: 0 },
  { id: "scout", sheet: "primary", x: 100, y: 0 },
  { id: "muse", sheet: "primary", x: 0, y: 100 },
  { id: "orbit", sheet: "primary", x: 100, y: 100 },
  { id: "nova", sheet: "more", x: 0, y: 0 },
  { id: "pixel", sheet: "more", x: 100, y: 0 },
  { id: "echo", sheet: "more", x: 0, y: 50 },
  { id: "ember", sheet: "more", x: 100, y: 50 },
  { id: "bolt", sheet: "more", x: 0, y: 100 },
  { id: "moss", sheet: "more", x: 100, y: 100 },
] as const;

export function AgentAvatar({ avatar, className = "" }: { avatar?: string | null; className?: string }) {
  const option = agentAvatars.find(item => item.id === avatar) ?? agentAvatars[0];
  return <span aria-hidden="true" className={`growth-agent-avatar ${className}`} style={{ backgroundImage: `url(/agent-avatars/${option.sheet}.png)`, backgroundSize: option.sheet === "primary" ? "200% 200%" : "200% 300%", backgroundPosition: `${option.x}% ${option.y}%` }} />;
}
