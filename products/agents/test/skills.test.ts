import { describe, expect, it, vi } from "vitest";
import { matchSkills, renderSkillInstructions, skillMatchingSchema, type SkillVersionRecord } from "../src/skills/contracts";
import { registerSkillDiscoveryTools } from "../src/skills/runtime-tools";
import { ToolRegistry } from "../src/tools/registry";
import { createExecutionScope } from "../src/runtime/execution-scope";
import { toolInvocationContextFromScope } from "../src/tools/types";

function skill(overrides: Partial<SkillVersionRecord> = {}): SkillVersionRecord {
  return {
    id: "skill-version-1",
    skill_definition_id: "skill-1",
    organization_id: "org-1",
    version_number: 1,
    status: "published",
    instructions: "Use the approved booking flow.",
    matching: skillMatchingSchema.parse({ keywords: ["booking"], phrases: ["make a booking"] }),
    required_capabilities: [],
    required_connectors: [],
    knowledge_source_ids: [],
    compatible_channels: [],
    compatible_audiences: [],
    checksum: "checksum",
    created_by: "owner",
    created_at: "2026-01-01T00:00:00.000Z",
    published_at: "2026-01-01T00:00:00.000Z",
    skill_name: "Booking",
    skill_status: "published",
    ...overrides,
  };
}

describe("procedural skills", () => {
  it("selects matching, compatible, authorized skill versions deterministically", () => {
    const result = matchSkills([
      skill(),
      skill({ id: "skill-version-2", matching: skillMatchingSchema.parse({ keywords: ["booking"] }), required_capabilities: ["calendar.create"] }),
      skill({ id: "skill-version-3", matching: skillMatchingSchema.parse({ keywords: ["research"] }) }),
    ], {
      text: "Please make a booking",
      grantedCapabilities: new Set(["calendar.create"]),
    });

    expect(result.map((entry) => entry.skill.id)).toEqual(["skill-version-1", "skill-version-2"]);
  });

  it("does not select revoked or incompatible skills", () => {
    const result = matchSkills([
      skill({ id: "revoked", status: "revoked" }),
      skill({ id: "wrong-channel", compatible_channels: ["telegram"] }),
      skill({ id: "wrong-audience", compatible_audiences: ["customer_service"] }),
    ], { text: "booking", channel: "platform", audience: "personal" });
    expect(result).toEqual([]);
  });

  it("enforces a character budget when rendering selected instructions", () => {
    const result = renderSkillInstructions([
      { skill: skill(), score: 3 },
      { skill: skill({ id: "second", skill_name: "Second", instructions: "This must not be loaded." }), score: 2 },
    ], 80);
    expect(result).toContain("Skill Booking v1");
    expect(result).not.toContain("This must not be loaded");
  });

  it("exposes Hermes-style list and view tools only for the pinned run snapshot", async () => {
    const ready = skill();
    const blocked = skill({ id: "blocked", skill_name: "Blocked", required_capabilities: ["calendar.create"] });
    const skills = {
      loadPinnedVersions: vi.fn(async () => [ready, blocked]),
      listPinnedFiles: vi.fn(async () => [{ path: "references/booking.md", checksum: "file-checksum", size: 24 }]),
      loadPinnedFile: vi.fn(async (_organizationId: string, _agentVersionId: string, _skillVersionId: string, path: string) => path === "references/booking.md"
        ? { path, checksum: "file-checksum", size: 24, content: "Booking reference material." }
        : null),
    } as never;
    const installationGrants = { effective: vi.fn(async () => ({ connectors: [] })) } as never;
    const registry = new ToolRegistry();
    registerSkillDiscoveryTools(registry, skills, installationGrants);
    const scope = createExecutionScope({
      organizationId: "org-1",
      installationId: "installation-1",
      agentDefinitionId: "agent-1",
      agentVersionId: "version-1",
      runId: "run-1",
      correlationId: "correlation-1",
      capabilityGrants: [],
    });
    const context = toolInvocationContextFromScope(scope);
    const list = await registry.invoke({ name: "skills_list", arguments: {}, grantedTools: new Set(["skills_list", "skill_view"]), context });
    expect(list.output).toMatchObject({ skills: [{ name: "Booking", readiness: "ready" }, { name: "Blocked", readiness: "unavailable" }] });
    const view = await registry.invoke({ name: "skill_view", arguments: { name: "Booking" }, grantedTools: new Set(["skills_list", "skill_view"]), context });
    expect(view.output).toMatchObject({ success: true, name: "Booking", content: "Use the approved booking flow." });
    expect(view.output).toMatchObject({ linked_files: { "references/booking.md": { checksum: "file-checksum", size: 24 } } });
    const file = await registry.invoke({ name: "skill_view", arguments: { name: "Booking", file_path: "references/booking.md" }, grantedTools: new Set(["skills_list", "skill_view"]), context });
    expect(file.output).toMatchObject({ success: true, content: "Booking reference material." });
    const blockedView = await registry.invoke({ name: "skill_view", arguments: { name: "Blocked" }, grantedTools: new Set(["skills_list", "skill_view"]), context });
    expect(blockedView.output).toMatchObject({ success: false, error: "skill_dependencies_not_ready" });
  });
});
