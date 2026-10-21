import { z } from "zod";
export const websiteAppearanceSchema = z.strictObject({
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#3730a3"),
  title: z.string().trim().min(1).max(80).default("Assistant"),
  greeting: z.string().trim().max(240).default("How can we help?"),
  launcherLabel: z.string().trim().min(1).max(32).default("Chat"),
  position: z.enum(["bottom-right", "bottom-left"]).default("bottom-right"),
  quickReplies: z.array(z.string().trim().min(1).max(120)).max(5).default([]),
});
export type WebsiteAppearance = z.infer<typeof websiteAppearanceSchema>;
export const defaultWebsiteAppearance = websiteAppearanceSchema.parse({});
