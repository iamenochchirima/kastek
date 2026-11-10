import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AgentTemplateError, loadAgentTemplates } from "../src/agent-templates.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const templateDirectory = join(repoRoot, "services/evals/templates/agents");

const validTemplate = (key: string) => JSON.stringify({
  key,
  name: `Template ${key}`,
  description: "A test template.",
  spec: {
    targetType: "business_agent",
    agentName: "Test agent",
    instructions: "Answer from approved knowledge only.",
    knowledge: { title: "Test knowledge", content: "Test content." },
    responsibilities: ["answer-questions"],
  },
});

async function withTemplateDirectory(
  files: Record<string, string>,
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "evals-agent-templates-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(directory, name), content);
    }
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function rejectsInvalidTemplate(directory: string): Promise<void> {
  await assert.rejects(loadAgentTemplates(directory), (error: unknown) => {
    assert.ok(error instanceof AgentTemplateError);
    assert.equal(error.statusCode, 500);
    assert.equal(error.code, "template_invalid");
    return true;
  });
}

test("loads the built-in agent templates", async () => {
  const templates = await loadAgentTemplates(templateDirectory);
  assert.ok(templates.length >= 8);
  const keys = templates.map((template) => template.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const template of templates) {
    assert.match(template.key, /^[a-z0-9][a-z0-9-]{0,79}$/);
    assert.ok(template.name.length > 0);
    assert.ok(template.description.length > 0);
    assert.ok(["platform_assistant", "business_agent"].includes(template.spec.targetType));
    assert.ok(template.spec.instructions.length > 0);
    assert.ok(template.spec.knowledge.title.length > 0);
    assert.ok(template.spec.knowledge.content.length > 0);
    assert.ok(template.spec.responsibilities.length > 0);
    if (template.spec.setup) {
      assert.equal("channels" in template.spec.setup, false);
    }
  }
  assert.ok(templates.some((template) => template.spec.targetType === "platform_assistant"));
  assert.ok(templates.some((template) => template.spec.offering === "customer-service"));
  assert.ok(templates.some((template) => template.spec.configuration != null));
  const full = templates.find((template) => template.key === "support-full");
  assert.deepEqual(full?.spec.responsibilities, [
    "answer-questions",
    "customer-support",
    "bookings",
    "enquiries",
  ]);
});

test("returns no templates when the directory is missing", async () => {
  assert.deepEqual(await loadAgentTemplates(join(repoRoot, "services/evals/templates/missing")), []);
});

test("rejects malformed template JSON", async () => {
  await withTemplateDirectory({ "broken.json": "{" }, rejectsInvalidTemplate);
});

test("rejects duplicate template keys", async () => {
  await withTemplateDirectory(
    { "one.json": validTemplate("duplicate"), "two.json": validTemplate("duplicate") },
    rejectsInvalidTemplate,
  );
});

test("rejects an invalid template specification", async () => {
  await withTemplateDirectory(
    {
      "invalid.json": JSON.stringify({
        key: "invalid",
        name: "Invalid",
        description: "Missing knowledge.",
        spec: {
          targetType: "business_agent",
          agentName: "Invalid agent",
          instructions: "Answer.",
          responsibilities: ["answer-questions"],
        },
      }),
    },
    rejectsInvalidTemplate,
  );
});
