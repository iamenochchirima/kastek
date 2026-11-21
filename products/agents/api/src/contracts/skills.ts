import { createHash } from "node:crypto";

/** A revision changes content; a family retains the server-verified publisher and source. */
export function skillFamilyId(input:{organizationId:string;name:string;sourceKind?:string;sourceSlug?:string|null;repository?:string|null;packagePath?:string|null}):string {
  const source=input.repository?["repository",input.organizationId,input.repository.toLowerCase(),input.packagePath??""]:
    input.sourceKind==="curated"?["curated","kasitek",input.sourceSlug??input.name]:["private",input.organizationId];
  return createHash("sha256").update(JSON.stringify(["skill-family-v1",...source,input.name])).digest("hex");
}

export const SKILL_PACKAGE_LIMITS = Object.freeze({ archiveBytes: 2_097_152, totalBytes: 2_097_152,
  fileBytes: 524_288, instructionBytes: 65_536, files: 128, pathBytes: 256, depth: 8, archiveEntries: 256 });
export interface SkillRequirements { readonly connectionProfiles: readonly string[]; readonly permissions: readonly string[]; readonly runtimes: readonly string[] }
export interface SkillPackageFile { readonly path: string; readonly content: string; readonly encoding: "base64"; readonly digest: string; readonly size: number }
export interface SkillPackage {
  readonly format: "agent-skills-v1"; readonly name: string; readonly description: string;
  readonly compatibility: string | null; readonly body: string; readonly contentDigest: string;
  readonly files: readonly SkillPackageFile[]; readonly totalBytes: number;
  readonly requirements: SkillRequirements;
}

/** Parsing and activation surface MemoryStore depends on. Implemented by the skills capability. */
export interface SkillPackageCodec {
  parse(input: unknown): SkillPackage;
  activate(pkg: SkillPackage, reviewedDigest: string): unknown;
}
