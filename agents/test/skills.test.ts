import { describe, expect, it } from "vitest";
import { matchSkills, renderSkillInstructions, skillMatchingSchema, type SkillVersionRecord } from "../src/skills/contracts";

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
});
