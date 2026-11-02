import { z } from "zod";
const avatarUrl = z.string().trim().max(2048).refine(value => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return !url.username && !url.password && (url.protocol === "https:" ||
      url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch { return false; }
}, "Use an HTTPS avatar URL or a local development URL");
export const websiteAppearanceSchema = z.strictObject({
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#3730a3"),
  title: z.string().trim().min(1).max(80).default("Assistant"),
  greeting: z.string().trim().max(240).default("How can we help?"),
  launcherLabel: z.string().trim().min(1).max(32).default("Chat"),
  position: z.enum(["bottom-right", "bottom-left"]).default("bottom-right"),
  quickReplies: z.array(z.string().trim().min(1).max(120)).max(5).default([]),
  avatarUrl: avatarUrl.default(""),
  launcherSize: z.number().int().min(44).max(96).default(56),
  windowWidth: z.number().int().min(300).max(600).default(390),
  windowHeight: z.number().int().min(360).max(800).default(620),
  borderRadius: z.number().int().min(0).max(28).default(16),
  launcherOffset: z.number().int().min(8).max(48).default(16),
  showBranding: z.boolean().default(true),
});
export type WebsiteAppearance = z.infer<typeof websiteAppearanceSchema>;
export const defaultWebsiteAppearance = websiteAppearanceSchema.parse({});
