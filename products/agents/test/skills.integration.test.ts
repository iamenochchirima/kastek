import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "../src/db/pool";
import { SkillRepository } from "../src/db/repositories/skill-repository";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("procedural skills persistence (integration)", () => {
  const pool = createPool({ AGENTS_DATABASE_URL: databaseUrl!, AGENTS_DATABASE_POOL_MAX: 2, NODE_ENV: "development" } as never);
  const repository = new SkillRepository(pool);
  const organizationId = `skills-${randomUUID()}`;
  const actorId = "skill-test-owner";
  const agentId = randomUUID();
  const agentVersionId = randomUUID();
  let skillId: string;
  let skillVersionId: string;
  let secondSkillVersionId: string;

  it("creates, publishes, pins, and loads one immutable skill version", async () => {
    const skill = await repository.createSkill(organizationId, actorId, {
      slug: `booking-${agentId.slice(0, 8)}`,
      name: "Booking flow",
      ownerType: "organization",
    });
    skillId = skill.id;
    const version = await repository.createVersion(organizationId, actorId, skill.id, {
      instructions: "Use the approved booking flow.",
      matching: { phrases: ["make a booking"] },
      requiredCapabilities: ["calendar.create"],
      files: [{ path: "references/booking.md", content: "Booking reference material." }],
    });
    skillVersionId = version.id;
    await repository.publishVersion(organizationId, actorId, skill.id, version.id);

    await pool.query("INSERT INTO agent_definitions (id, organization_id, name, slug, created_by) VALUES ($1, $2, 'Skill test agent', $3, $4)", [agentId, organizationId, `skill-agent-${agentId.slice(0, 8)}`, actorId]);
    await pool.query("INSERT INTO agent_versions (id, agent_definition_id, version_number, instructions, checksum, created_by) VALUES ($1, $2, 1, 'test', 'test', $3)", [agentVersionId, agentId, actorId]);
    await repository.pinVersion(organizationId, actorId, agentVersionId, version.id);

    const loaded = await repository.loadPinnedVersions(organizationId, agentVersionId);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ id: version.id, skill_name: "Booking flow", status: "published" });
    expect(loaded[0]!.matching.phrases).toEqual(["make a booking"]);
    expect(await repository.listPinnedFiles(organizationId, agentVersionId, version.id)).toMatchObject([
      { path: "references/booking.md", size: 27 },
    ]);
    expect(await repository.loadPinnedFile(organizationId, agentVersionId, version.id, "references/booking.md")).toMatchObject({
      content: "Booking reference material.",
    });

    const secondVersion = await repository.createVersion(organizationId, actorId, skill.id, {
      instructions: "Use the approved booking flow and confirm the time zone.",
      matching: { phrases: ["make a booking"] },
      requiredCapabilities: ["calendar.create"],
    });
    secondSkillVersionId = secondVersion.id;
    expect(secondVersion).toMatchObject({ version_number: version.version_number + 1, status: "draft", published_at: null });
    await repository.publishVersion(organizationId, actorId, skill.id, secondVersion.id);
    await repository.pinVersion(organizationId, actorId, agentVersionId, secondVersion.id);
    const publishedVersions = await repository.loadPinnedVersions(organizationId, agentVersionId);
    expect(publishedVersions.map((entry) => entry.version_number)).toEqual([2, 1]);
    expect(publishedVersions.every((entry) => entry.status === "published" && entry.published_at)).toBe(true);
  });

  it("does not expose an organization skill to another organization", async () => {
    expect(await repository.listSkills(`other-${organizationId}`)).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: skillId })]));
  });

  afterAll(async () => {
    await pool.query("DELETE FROM agent_version_skills WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_versions WHERE id = $1", [agentVersionId]);
    await pool.query("DELETE FROM agent_definitions WHERE id = $1", [agentId]);
    if (skillVersionId) await pool.query("DELETE FROM agent_skill_versions WHERE id = $1", [skillVersionId]);
    if (secondSkillVersionId) await pool.query("DELETE FROM agent_skill_versions WHERE id = $1", [secondSkillVersionId]);
    if (skillId) await pool.query("DELETE FROM agent_skill_definitions WHERE id = $1", [skillId]);
    await pool.end();
  });
});
