export function getWhatsappAvatarInitials(input: { name?: string | null; phone?: string | null }) {
  const source = (input.name || input.phone || "?").trim();
  if (!source) return "?";

  const words = source
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (words.length >= 2) {
    return `${words[0][0] || ""}${words[1][0] || ""}`.toUpperCase();
  }

  const compact = words[0] || source;
  return compact.slice(0, 2).toUpperCase();
}

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

export function getWhatsappAvatarStyles(input: { name?: string | null; phone?: string | null }) {
  const key = `${input.name || ""}:${input.phone || ""}`;
  const hash = hashString(key || "unknown");

  const hue = hash % 360;
  const background = `hsl(${hue}deg 52% 24%)`;
  const border = `hsl(${hue}deg 52% 34%)`;
  const text = `hsl(${hue}deg 92% 80%)`;

  return {
    background,
    borderColor: border,
    color: text,
  };
}
