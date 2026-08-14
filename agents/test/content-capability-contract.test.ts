import { describe, expect, it } from "vitest";
import { createDefaultTools } from "../src/temporal/activities";

const context = {
  organizationId: "org-test",
  agentId: "agent-test",
  agentVersionId: "version-test",
  installationId: "installation-test",
  runId: "run-test",
  correlationId: "correlation-test",
};

describe("content capability contract", () => {
  const registry = createDefaultTools();

  it("keeps every content capability owned, scoped, redacted, and classified", () => {
    const manifests = registry.manifests().filter((manifest) => manifest.name.startsWith("kasitek.core.content_"));
    expect(manifests.map((manifest) => manifest.name)).toEqual([
      "kasitek.core.content_posts_list",
      "kasitek.core.content_post_get",
      "kasitek.core.content_post_update",
      "kasitek.core.content_post_draft",
      "kasitek.core.content_post_publish",
      "kasitek.core.content_post_schedule",
      "kasitek.core.content_post_unschedule",
      "kasitek.core.content_post_delete",
    ]);

    for (const manifest of manifests) {
      expect(manifest.manifest.ownerService).toBe("kasitek-core");
      expect(manifest.manifest.requiredScope).toMatch(/^content\.(read|write|publish)$/);
      expect(manifest.manifest.auditClassification).toMatch(/^(restricted|full)$/);
      expect(manifest.manifest.redaction.every((entry) => entry.length > 0)).toBe(true);
      if (manifest.name !== "kasitek.core.content_post_delete") expect(manifest.manifest.redaction.length).toBeGreaterThan(0);
      if (manifest.name.endsWith("_publish") || manifest.name.endsWith("_schedule") || manifest.name.endsWith("_unschedule") || manifest.name.endsWith("_delete")) {
        expect(manifest.manifest).toMatchObject({ execution: "durable", idempotency: "required", approval: "always" });
        expect(manifest.requiresApproval).toBe(true);
      } else {
        expect(manifest.manifest.execution).toBe("immediate");
        expect(manifest.manifest.approval).toBe("none");
        expect(manifest.requiresApproval).toBe(false);
      }
    }
  });

  it("validates the public content argument contract before handlers run", () => {
    expect(registry.validateArguments("kasitek.core.content_posts_list", {})).toBe(true);
    expect(registry.validateArguments("kasitek.core.content_posts_list", { unexpected: true })).toBe(false);
    expect(registry.validateArguments("kasitek.core.content_post_get", { postId: "post-1" })).toBe(true);
    expect(registry.validateArguments("kasitek.core.content_post_get", {})).toBe(false);
    expect(registry.validateArguments("kasitek.core.content_post_draft", { content: "Draft", channels: ["threads"] })).toBe(true);
    expect(registry.validateArguments("kasitek.core.content_post_draft", { content: "", channels: [] })).toBe(false);
    expect(registry.validateArguments("kasitek.core.content_post_publish", { postId: "post-1", platform: "threads" })).toBe(true);
    expect(registry.validateArguments("kasitek.core.content_post_publish", { postId: "post-1" })).toBe(false);
    expect(registry.validateArguments("kasitek.core.content_post_schedule", { postId: "post-1", scheduledFor: "2026-08-15T12:00:00.000Z" })).toBe(true);
    expect(registry.validateArguments("kasitek.core.content_post_schedule", { postId: "post-1", scheduledFor: "tomorrow" })).toBe(false);
  });

  it("enforces grants and approval before any content handler is invoked", async () => {
    await expect(registry.invoke({
      name: "kasitek.core.content_post_publish",
      arguments: { postId: "post-1", platform: "threads" },
      context,
      grantedTools: new Set(),
    })).rejects.toMatchObject({ code: "TOOL_NOT_GRANTED" });

    await expect(registry.invoke({
      name: "kasitek.core.content_post_publish",
      arguments: { postId: "post-1", platform: "threads" },
      context,
      grantedTools: new Set(["kasitek.core.content_post_publish"]),
    })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  });
});
