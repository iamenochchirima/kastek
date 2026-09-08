import { z } from "zod";
import { recordSkillSelection } from "../telemetry/spans";

const skillAudienceSchema = z.enum(["personal", "customer_service"]);

export const skillMatchingSchema = z.object({
  keywords: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  phrases: z.array(z.string().trim().min(1).max(240)).max(20).default([]),
  channels: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  audiences: z.array(skillAudienceSchema).max(2).default([]),
}).strict().default({ keywords: [], phrases: [], channels: [], audiences: [] });

export const createSkillInputSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2_000).optional(),
  ownerType: z.enum(["organization", "user"]).default("organization"),
  catalogId: z.string().trim().min(1).max(180).optional(),
}).strict();
export type CreateSkillInput = z.infer<typeof createSkillInputSchema>;

export const createSkillVersionInputSchema = z.object({
  instructions: z.string().trim().min(1).max(40_000),
  matching: skillMatchingSchema,
  requiredCapabilities: z.array(z.string().trim().min(1).max(240)).max(100).default([]),
  requiredConnectors: z.array(z.string().trim().min(1).max(240)).max(50).default([]),
  knowledgeSourceIds: z.array(z.string().trim().min(1).max(240)).max(100).default([]),
  compatibleChannels: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  compatibleAudiences: z.array(skillAudienceSchema).max(2).default([]),
}).strict();
export type CreateSkillVersionInput = z.infer<typeof createSkillVersionInputSchema>;

export interface SkillDefinitionRecord {
  id: string;
  organization_id: string;
  owner_type: "platform" | "organization" | "user";
  owner_id: string;
  slug: string;
  catalog_id: string | null;
  name: string;
  description: string | null;
  status: "draft" | "published" | "deprecated" | "revoked";
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface SkillVersionRecord {
  id: string;
  skill_definition_id: string;
  organization_id: string;
  version_number: number;
  status: "draft" | "published" | "retired" | "revoked";
  instructions: string;
  matching: z.infer<typeof skillMatchingSchema>;
  required_capabilities: string[];
  required_connectors: string[];
  knowledge_source_ids: string[];
  compatible_channels: string[];
  compatible_audiences: Array<"personal" | "customer_service">;
  checksum: string;
  created_by: string;
  created_at: string;
  published_at: string | null;
  skill_slug?: string;
  skill_name?: string;
  skill_status?: SkillDefinitionRecord["status"];
}

export interface MatchedSkill {
  skill: SkillVersionRecord;
  score: number;
}

export interface SkillMatchInput {
  text: string;
  channel?: string;
  audience?: "personal" | "customer_service";
  grantedCapabilities?: ReadonlySet<string>;
  grantedConnectors?: ReadonlySet<string>;
  maxSkills?: number;
  maxInstructionCharacters?: number;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function containsPhrase(text: string, phrase: string): boolean {
  return normalized(text).includes(normalized(phrase));
}

/** Match only metadata declared by the skill owner; no model call is involved. */
export function matchSkills(skills: readonly SkillVersionRecord[], input: SkillMatchInput): MatchedSkill[] {
  const text = normalized(input.text);
  const channel = input.channel ? normalized(input.channel) : undefined;
  const grantedCapabilities = input.grantedCapabilities ?? new Set<string>();
  const grantedConnectors = input.grantedConnectors ?? new Set<string>();
  const matches: MatchedSkill[] = [];
  for (const skill of skills) {
    if (skill.status !== "published" || skill.skill_status === "revoked") continue;
    if (skill.compatible_channels.length && (!channel || !skill.compatible_channels.some((value) => normalized(value) === channel))) continue;
    if (skill.compatible_audiences.length && (!input.audience || !skill.compatible_audiences.includes(input.audience))) continue;
    if (skill.required_capabilities.some((capability) => !grantedCapabilities.has(capability))) continue;
    if (skill.required_connectors.some((connector) => !grantedConnectors.has(connector))) continue;
    const phrases = skill.matching.phrases.filter((phrase) => containsPhrase(text, phrase));
    const keywords = skill.matching.keywords.filter((keyword) => containsPhrase(text, keyword));
    if (skill.matching.phrases.length || skill.matching.keywords.length) {
      if (!phrases.length && !keywords.length) continue;
    }
    const score = phrases.length * 3 + keywords.length;
    matches.push({ skill, score });
  }
  const selected = matches
    .sort((left, right) => right.score - left.score || left.skill.id.localeCompare(right.skill.id))
    .slice(0, Math.max(0, input.maxSkills ?? 8));
  recordSkillSelection({ outcome: selected.length ? "matched" : "empty", count: selected.length });
  return selected;
}

/** Render selected skill instructions within an explicit context budget. */
export function renderSkillInstructions(matches: readonly MatchedSkill[], maxCharacters = 24_000): string | undefined {
  const sections: string[] = [];
  let remaining = Math.max(0, Math.trunc(maxCharacters));
  for (const { skill } of matches) {
    if (remaining <= 0) break;
    const header = `Skill ${skill.skill_name ?? skill.skill_slug ?? skill.id} v${skill.version_number}`;
    const section = `${header}:\n${skill.instructions.trim()}`;
    if (section.length > remaining) break;
    sections.push(section);
    remaining -= section.length;
  }
  return sections.length ? sections.join("\n\n") : undefined;
}
