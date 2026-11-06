import { z } from "zod";
import { channelKindSchema } from "../../contracts/channel-adapters";
import { channelModeSchema } from "../../contracts/channel-connections";
import definitions from "./catalogue.json";
import { installedChannelHandlers } from "./providers";

const attachment = z.enum(["image", "audio", "video", "document"]);
export const channelDefinitionSchema = z.strictObject({
  kind: channelKindSchema, name: z.string().min(1).max(120), handler: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  revision: z.string().min(1).max(64), modes: z.array(channelModeSchema).min(1),
  setup: z.enum(["website", "embedded_signup", "bot_token", "oauth"]), assetLabel: z.string().min(1).max(120),
  prerequisites: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(16),
  capabilities: z.strictObject({ inboundText: z.boolean(), inboundAttachments: z.array(attachment),
    outboundText: z.boolean(), outboundAttachments: z.array(attachment),
    receipts: z.array(z.enum(["accepted", "sent", "delivered", "read", "failed"])), templates: z.boolean(), callbacks: z.boolean() }),
  restrictions: z.array(z.string().min(1).max(256)).max(16),
});
export type ChannelDefinition = z.infer<typeof channelDefinitionSchema>;

export function parseChannelCatalogue(raw: unknown, installedHandlers: ReadonlySet<string> = installedChannelHandlers): readonly ChannelDefinition[] {
  const parsed = z.array(channelDefinitionSchema).min(1).max(100).parse(raw);
  const seen = new Set<string>();
  for (const definition of parsed) {
    if (seen.has(definition.kind) || !installedHandlers.has(definition.handler)) throw new Error("Invalid or uninstalled channel handler");
    seen.add(definition.kind);
    const expected = definition.kind === "website" ? ["website"] : definition.kind === "telegram" ? ["bot"] : definition.kind === "whatsapp" ? ["cloud_api", "growth_managed"] : definition.kind === "facebook" ? ["meta", "growth_managed"] : ["meta", "instagram_login", "growth_managed"];
    if (definition.modes.some(mode => !expected.includes(mode))) throw new Error("Unsupported channel connection mode");
  }
  function freeze(value: unknown): void { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } }
  freeze(parsed); return parsed;
}
export const builtinChannelCatalogue = parseChannelCatalogue(definitions);
export const getChannelDefinition = (kind: string, catalogue: readonly ChannelDefinition[] = builtinChannelCatalogue) => catalogue.find(item => item.kind === kind);
