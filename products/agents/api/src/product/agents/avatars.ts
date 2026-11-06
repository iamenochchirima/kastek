import { randomInt } from "node:crypto";
import { z } from "zod";

/** Avatar identifiers render as icon tiles in the Agents web app. Keep in sync with its catalog. */
export const agentAvatars = ["atlas", "scout", "muse", "orbit", "nova", "pixel", "echo", "ember", "bolt", "moss"] as const;
export type AgentAvatar = (typeof agentAvatars)[number];
export const agentAvatarSchema = z.enum(agentAvatars);

export function randomAgentAvatar(): AgentAvatar {
  return agentAvatars[randomInt(agentAvatars.length)]!;
}
