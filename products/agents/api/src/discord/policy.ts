export function parseDiscordIds(value: unknown): Set<string> {
  if (typeof value !== "string") return new Set();
  return new Set(value.split(",").map((part) => part.trim()).filter(Boolean));
}

export interface DiscordAccessPolicy {
  allowedUsers: Set<string>;
  allowedChannels: Set<string>;
  requireMention: boolean;
}

/**
 * Empty server-channel configuration is intentionally deny-by-default. This
 * mirrors Waku's safety posture: DMs are useful for pairing, while a shared
 * server must be explicitly opted in and normally requires a mention.
 */
export function shouldDiscordAnswer(input: {
  isDm: boolean;
  authorId: string;
  channelId: string;
  mentioned: boolean;
  policy: DiscordAccessPolicy;
}): boolean {
  if (input.policy.allowedUsers.size > 0 && !input.policy.allowedUsers.has(input.authorId)) return false;
  if (input.isDm) return true;
  if (!input.policy.allowedChannels.has(input.channelId)) return false;
  return input.mentioned || !input.policy.requireMention;
}

export function shouldDiscordAnswerComponent(input: {
  isDm: boolean;
  authorId: string;
  channelId: string;
  policy: DiscordAccessPolicy;
}): boolean {
  if (input.policy.allowedUsers.size > 0 && !input.policy.allowedUsers.has(input.authorId)) return false;
  return input.isDm || input.policy.allowedChannels.has(input.channelId);
}

export function stripDiscordMention(content: string, botId: string): string {
  return content.replaceAll(`<@${botId}>`, " ").replaceAll(`<@!${botId}>`, " ").trim();
}

export function readDiscordAccessPolicy(metadata: Record<string, unknown>): DiscordAccessPolicy {
  const discord = metadata.discord && typeof metadata.discord === "object" ? metadata.discord as Record<string, unknown> : {};
  const policy = metadata.discordAccess && typeof metadata.discordAccess === "object" ? metadata.discordAccess as Record<string, unknown> : {};
  const requireMentionValue = policy.requireMention ?? discord.requireMention;
  return {
    allowedUsers: parseDiscordIds(policy.allowedUsers ?? discord.allowedUsers),
    allowedChannels: parseDiscordIds(policy.allowedChannels ?? discord.allowedChannels),
    requireMention: requireMentionValue === undefined || requireMentionValue === true || requireMentionValue === "true" || requireMentionValue === "1",
  };
}
