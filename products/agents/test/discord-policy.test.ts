import { describe, expect, it } from "vitest";
import { shouldDiscordAnswer, shouldDiscordAnswerComponent, stripDiscordMention } from "../src/discord/policy";

const base = { authorId: "user-1", channelId: "channel-1", mentioned: true, policy: { allowedUsers: new Set<string>(), allowedChannels: new Set<string>(), requireMention: true } };

describe("Discord access policy", () => {
  it("keeps an unconfigured server closed while allowing DMs", () => {
    expect(shouldDiscordAnswer({ ...base, isDm: false })).toBe(false);
    expect(shouldDiscordAnswer({ ...base, isDm: true })).toBe(true);
  });

  it("requires an opted-in channel and mention by default", () => {
    const policy = { ...base.policy, allowedChannels: new Set(["channel-1"]) };
    expect(shouldDiscordAnswer({ ...base, isDm: false, policy, mentioned: true })).toBe(true);
    expect(shouldDiscordAnswer({ ...base, isDm: false, policy, mentioned: false })).toBe(false);
  });

  it("gates component clicks by user and channel without requiring a mention", () => {
    const policy = { ...base.policy, allowedUsers: new Set(["user-1"]), allowedChannels: new Set(["channel-1"]) };
    expect(shouldDiscordAnswerComponent({ authorId: "user-1", channelId: "channel-1", isDm: false, policy })).toBe(true);
    expect(shouldDiscordAnswerComponent({ authorId: "other", channelId: "channel-1", isDm: false, policy })).toBe(false);
    expect(shouldDiscordAnswerComponent({ authorId: "user-1", channelId: "other", isDm: false, policy })).toBe(false);
  });

  it("strips both Discord mention encodings", () => {
    expect(stripDiscordMention("<@42> hello <@!42>", "42")).toBe("hello");
  });
});
