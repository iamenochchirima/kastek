import type { SkillRepository } from "../db/repositories/skill-repository";
import type { InstallationGrantRepository } from "../db/repositories/installation-grant-repository";
import type { ToolInvocationContext } from "../tools/types";
import type { ToolRegistry } from "../tools/registry";
import type { SkillLinkedFileMetadata, SkillVersionRecord } from "./contracts";

/**
 * Hermes-compatible progressive skill discovery for one admitted run.
 *
 * The list is metadata-only. `skill_view` is the only operation that returns
 * instructions, and it can only read a skill already pinned to this agent
 * version. Skill instructions never grant a tool or connector.
 */
export const SKILL_DISCOVERY_TOOL_NAMES = ["skills_list", "skill_view"] as const;

type SkillRuntimeEntry = {
  skill: SkillVersionRecord;
  ready: boolean;
  reason?: "dependency_not_ready" | "not_pinned" | "not_published";
};

async function pinnedSkillEntries(
  context: ToolInvocationContext,
  skills: SkillRepository,
  installationGrants: InstallationGrantRepository,
): Promise<SkillRuntimeEntry[]> {
  const [pinned, grants] = await Promise.all([
    skills.loadPinnedVersions(context.organizationId, context.agentVersionId),
    installationGrants.effective(context.organizationId, context.installationId),
  ]);
  const allowedCapabilities = new Set(context.scope.capabilityGrants ?? []);
  const allowedConnectors = new Set(grants.connectors);
  return pinned.map((skill) => {
    const missingCapability = skill.required_capabilities.some((capability) => !allowedCapabilities.has(capability));
    const missingConnector = skill.required_connectors.some((connector) => !allowedConnectors.has(connector));
    return {
      skill,
      ready: !missingCapability && !missingConnector && skill.status === "published" && skill.skill_status === "published",
      ...(!missingCapability && !missingConnector && skill.status === "published" && skill.skill_status === "published"
        ? {}
        : { reason: "dependency_not_ready" as const }),
    };
  });
}

function publicSkill(entry: SkillRuntimeEntry): Record<string, unknown> {
  const skill = entry.skill;
  return {
    id: skill.id,
    name: skill.skill_name ?? skill.skill_slug ?? skill.id,
    version: String(skill.version_number),
    description: skill.skill_description ?? skill.skill_name ?? skill.skill_slug ?? "",
    readiness: entry.ready ? "ready" : "unavailable",
    ...(entry.reason ? { reason: entry.reason } : {}),
  };
}

function linkedFileIndex(files: readonly SkillLinkedFileMetadata[]): Record<string, { checksum: string; size: number }> {
  return Object.fromEntries(files.map((file) => [file.path, { checksum: file.checksum, size: file.size }]));
}

function isSafeLinkedFilePath(path: string): boolean {
  return /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(path)
    && !path.startsWith("/")
    && !path.split("/").includes("..");
}

/** Register the two read-only skill tools into the per-run registry. */
export function registerSkillDiscoveryTools(
  registry: ToolRegistry,
  skills: SkillRepository,
  installationGrants: InstallationGrantRepository,
): void {
  if (!registry.get("skills_list")) {
    registry.register({
      name: "skills_list",
      version: "1.0.0",
      description: "List the skills enabled for this agent. Use skill_view to load one skill's instructions.",
      riskClass: "read",
      requiresApproval: false,
      timeoutMs: 8_000,
      inputSchema: {
        type: "object",
        properties: { category: { type: "string", maxLength: 120 } },
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          skills: { type: "array", items: { type: "object", additionalProperties: true } },
          usageHint: { type: "string" },
        },
        required: ["skills", "usageHint"],
        additionalProperties: false,
      },
      manifest: {
        ownerService: "agents",
        requiredScope: "agent.skills.read",
        execution: "immediate",
        idempotency: "not_applicable",
        approval: "none",
        auditClassification: "access",
        redaction: [],
      },
      handler: async (context, args) => {
        const entries = await pinnedSkillEntries(context, skills, installationGrants);
        const category = typeof args.category === "string" ? args.category.trim().toLocaleLowerCase() : "";
        const visible = category
          ? entries.filter(({ skill }) => [skill.skill_name, skill.skill_slug, skill.skill_description]
            .filter((value): value is string => Boolean(value))
            .some((value) => value.toLocaleLowerCase().includes(category)))
          : entries;
        return {
          skills: visible.map(publicSkill),
          usageHint: "Use skill_view with a skill name to load its instructions.",
        };
      },
    });
  }

  if (!registry.get("skill_view")) {
    registry.register({
      name: "skill_view",
      version: "1.0.0",
      description: "Load the instructions for one enabled skill. Skill instructions never grant permissions.",
      riskClass: "read",
      requiresApproval: false,
      timeoutMs: 8_000,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 240 },
          file_path: { type: "string", maxLength: 240 },
        },
        required: ["name"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          name: { type: "string" },
          description: { type: "string" },
          content: { type: "string" },
          linked_files: { type: "object", additionalProperties: true },
          usage_hint: { type: "string" },
          error: { type: "string" },
        },
        required: ["success", "name", "description", "content", "linked_files"],
        additionalProperties: false,
      },
      manifest: {
        ownerService: "agents",
        requiredScope: "agent.skills.read",
        execution: "immediate",
        idempotency: "not_applicable",
        approval: "none",
        auditClassification: "access",
        redaction: [],
      },
      handler: async (context, args) => {
        const requested = String(args.name).trim().toLocaleLowerCase();
        const filePath = typeof args.file_path === "string" ? args.file_path.trim() : "";
        const entries = await pinnedSkillEntries(context, skills, installationGrants);
        const entry = entries.find(({ skill }) => [skill.id, skill.skill_slug, skill.skill_name]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLocaleLowerCase() === requested));
        if (!entry) {
          return {
            success: false,
            name: String(args.name),
            description: "",
            content: "",
            linked_files: {},
            error: "skill_not_enabled",
          };
        }
        const name = entry.skill.skill_name ?? entry.skill.skill_slug ?? entry.skill.id;
        if (!entry.ready) {
          return {
            success: false,
            name,
            description: entry.skill.skill_description ?? entry.skill.skill_name ?? entry.skill.skill_slug ?? "",
            content: "",
            linked_files: {},
            error: "skill_dependencies_not_ready",
          };
        }
        const files = await skills.listPinnedFiles(context.organizationId, context.agentVersionId, entry.skill.id);
        const linkedFiles = linkedFileIndex(files);
        if (filePath) {
          if (!isSafeLinkedFilePath(filePath)) {
            return {
              success: false,
              name,
              description: entry.skill.skill_description ?? entry.skill.skill_name ?? entry.skill.skill_slug ?? "",
              content: "",
              linked_files: linkedFiles,
              usage_hint: "Use a relative linked file path returned by skill_view.",
              error: "linked_file_invalid_path",
            };
          }
          const file = await skills.loadPinnedFile(context.organizationId, context.agentVersionId, entry.skill.id, filePath);
          if (!file) {
            return {
              success: false,
              name,
              description: entry.skill.skill_description ?? entry.skill.skill_name ?? entry.skill.skill_slug ?? "",
              content: "",
              linked_files: linkedFiles,
              usage_hint: "Use one of the linked file paths returned by skill_view.",
              error: "linked_file_not_found",
            };
          }
          return {
            success: true,
            name,
            description: entry.skill.skill_description ?? entry.skill.skill_name ?? entry.skill.skill_slug ?? "",
            content: file.content,
            linked_files: linkedFiles,
            usage_hint: "Linked file content is reference material; use the supplied tool schemas for actions.",
          };
        }
        return {
          success: true,
          name,
          description: entry.skill.skill_description ?? entry.skill.skill_name ?? entry.skill.skill_slug ?? "",
          content: entry.skill.instructions,
          linked_files: linkedFiles,
          usage_hint: files.length
            ? "Use file_path with one of the linked files when the skill workflow needs reference material."
            : "Skill instructions are guidance only; use the supplied tool schemas for actions.",
        };
      },
    });
  }
}
