import { describe, expect, it } from "vitest";
import { addPluginPackageSelection } from "../src/db/repositories/agent-repository";

describe("Playground extension activation projection", () => {
  it("adds a canonical plugin package and grant without mutating the source objects", () => {
    const configuration = {
      model: "test-model",
      extensions: {
        packages: [],
      },
    };
    const policy = {
      allowedTools: ["platform.current_time"],
      extensions: { grants: [] },
    };

    const result = addPluginPackageSelection(configuration, policy, {
      id: "reviewed.calendar",
      version: "1.0.0",
      checksum: "a".repeat(64),
    });

    expect(result.changed).toBe(true);
    expect(result.configuration.extensions).toMatchObject({
      packages: [{ kind: "plugin", id: "reviewed.calendar", version: "1.0.0", checksum: "a".repeat(64) }],
    });
    expect(result.policy.extensions).toMatchObject({
      grants: [{ kind: "plugin", id: "reviewed.calendar", permissions: [] }],
    });
    expect(configuration.extensions.packages).toEqual([]);
    expect(policy.extensions.grants).toEqual([]);
  });

  it("preserves legacy grants while creating the canonical package grant", () => {
    const result = addPluginPackageSelection(
      { extensions: { grants: { pluginIds: ["existing.plugin"], skillIds: ["booking"] } } },
      { extensions: { grants: { pluginIds: ["existing.plugin"] } } },
      { id: "new.plugin", version: "2.0.0", checksum: "b".repeat(64) },
    );

    expect(result.configuration.extensions).toMatchObject({
      grants: { pluginIds: ["existing.plugin", "new.plugin"], skillIds: ["booking"] },
    });
    expect(result.policy.extensions).toMatchObject({
      grants: [{ kind: "plugin", id: "new.plugin", permissions: [] }],
    });
  });

  it("is idempotent once the package and grant are selected", () => {
    const configuration = {
      extensions: {
        packages: [{ kind: "plugin", id: "same.plugin", version: "1.0.0", checksum: "c".repeat(64), configuration: {} }],
      },
    };
    const policy = {
      extensions: { grants: [{ kind: "plugin", id: "same.plugin", permissions: [] }] },
    };

    const result = addPluginPackageSelection(configuration, policy, {
      id: "same.plugin",
      version: "1.0.0",
      checksum: "c".repeat(64),
    });

    expect(result.changed).toBe(false);
    expect(result.configuration.extensions).toEqual(configuration.extensions);
    expect(result.policy.extensions).toEqual(policy.extensions);
  });
});
