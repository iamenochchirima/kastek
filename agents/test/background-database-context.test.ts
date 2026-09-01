import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { currentDatabaseContext, runWithRequiredDatabaseContext } from "../src/db/context";

const backgroundBoundaries = [
  "src/temporal/activities.ts",
  "src/temporal/worker.ts",
  "src/transcription/worker.ts",
  "src/memory/consolidation-worker.ts",
  "src/analytics/publisher-worker.ts",
  "src/analytics/readiness-sweep.ts",
  "src/discord/gateway.ts",
  "src/system/bootstrap-kasiai.ts",
  "src/system/release-kasiai.ts",
] as const;

describe("background database context boundaries", () => {
  it("rejects a background operation without both organization and actor scope", async () => {
    expect(() => runWithRequiredDatabaseContext("test-process", undefined, async () => undefined))
      .toThrow(expect.objectContaining({ code: "DATABASE_CONTEXT_REQUIRED", process: "test-process" }));
    expect(() => runWithRequiredDatabaseContext("test-process", { organizationId: "org-1" }, async () => undefined))
      .toThrow(expect.objectContaining({ code: "DATABASE_CONTEXT_REQUIRED", process: "test-process" }));
  });

  it("restores the caller context after a required nested scope", async () => {
    await runWithRequiredDatabaseContext(
      "outer-process",
      { organizationId: "org-1", actorId: "actor-1" },
      async () => {
        expect(currentDatabaseContext()).toEqual({ organizationId: "org-1", actorId: "actor-1" });
        await runWithRequiredDatabaseContext(
          "inner-process",
          { organizationId: "org-2", actorId: "actor-2", operator: true },
          async () => expect(currentDatabaseContext()).toEqual({ organizationId: "org-2", actorId: "actor-2", operator: true }),
        );
        expect(currentDatabaseContext()).toEqual({ organizationId: "org-1", actorId: "actor-1" });
      },
    );
    expect(currentDatabaseContext()).toBeUndefined();
  });

  it("requires every background entrypoint to use the fail-closed boundary", async () => {
    await Promise.all(backgroundBoundaries.map(async (relativePath) => {
      const source = await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
      expect(source, relativePath).toContain("runWithRequiredDatabaseContext");
    }));
  });
});
