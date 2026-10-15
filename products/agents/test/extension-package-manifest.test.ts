import { describe, expect, it } from "vitest";
import {
  assessExtensionPackageReadiness,
  validateAndAssessExtensionPackage,
  validateExtensionPackageManifest,
  type ExtensionPackageRuntime,
} from "../src/extensions/package-manifest";

const checksum = "a".repeat(64);

function skillManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: "booking",
    version: "1.2.0",
    checksum,
    kind: "skill",
    runtime: {
      id: "kasitek-agent-runtime",
      versionRange: "^2.0.0",
      requiredFeatures: ["bounded-context-v2"],
    },
    execution: { mode: "declarative", instructionRef: "skills/booking.md" },
    dependencies: [{ kind: "mcp_adapter", id: "calendar", versionRange: "^1.0.0" }],
    permissions: ["calendar.read"],
    configSchema: {
      type: "object",
      properties: {
        locale: { type: "string", default: "en-ZA", enum: ["en-ZA", "en-US"] },
        maxResults: { type: "integer", minimum: 1, maximum: 20, default: 5 },
      },
      required: ["locale"],
      additionalProperties: false,
    },
    ...overrides,
  };
}

function runtime(overrides: Partial<ExtensionPackageRuntime> = {}): ExtensionPackageRuntime {
  return {
    runtimeId: "kasitek-agent-runtime",
    runtimeVersion: "2.4.0",
    supportedFeatures: ["bounded-context-v2"],
    supportedExecutionModes: ["declarative", "plugin", "mcp_stdio", "mcp_http"],
    trustedChecksums: [{ kind: "skill", id: "booking", version: "1.2.0", checksum }],
    installedPackages: [{ kind: "mcp_adapter", id: "calendar", version: "1.4.0", ready: true }],
    grantedPermissions: ["calendar.read"],
    configuration: { locale: "en-ZA", maxResults: 10 },
    ...overrides,
  };
}

describe("extension package manifests", () => {
  it("validates a declarative skill and returns an immutable canonical manifest", () => {
    const result = validateExtensionPackageManifest(skillManifest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest).toMatchObject({
      id: "booking",
      kind: "skill",
      execution: { mode: "declarative", instructionRef: "skills/booking.md" },
      dependencies: [{ kind: "mcp_adapter", id: "calendar", versionRange: "^1.0.0" }],
    });
    expect(Object.isFrozen(result.manifest)).toBe(true);
    expect(Object.isFrozen(result.manifest.configSchema)).toBe(true);
  });

  it("keeps declarative skills separate from executable plugins and MCP adapters", () => {
    const plugin = validateExtensionPackageManifest({
      ...skillManifest(),
      id: "calendar-plugin",
      kind: "plugin",
      execution: { mode: "plugin", entrypoint: "calendar_plugin.register" },
      dependencies: [],
      permissions: [],
      configSchema: undefined,
    });
    const mcp = validateExtensionPackageManifest({
      ...skillManifest(),
      id: "calendar-mcp",
      kind: "mcp_adapter",
      execution: {
        mode: "mcp_http",
        serverName: "calendar",
        endpoint: "https://calendar.example.test/mcp",
        protocolVersion: "2025-06-18",
      },
      dependencies: [],
      permissions: [],
      configSchema: undefined,
    });

    expect(plugin).toMatchObject({ ok: true });
    expect(mcp).toMatchObject({ ok: true });
    expect(validateExtensionPackageManifest({
      ...skillManifest(),
      execution: { mode: "plugin", entrypoint: "calendar_plugin.register" },
    })).toMatchObject({
      ok: false,
      failures: expect.arrayContaining([expect.objectContaining({ code: "execution_mode_mismatch" })]),
    });
  });

  it("rejects unsafe or incomplete executable declarations without loading them", () => {
    const result = validateExtensionPackageManifest({
      ...skillManifest(),
      kind: "plugin",
      execution: { mode: "plugin", entrypoint: "/tmp/../../arbitrary.js" },
    });

    expect(result).toMatchObject({
      ok: false,
      failures: expect.arrayContaining([expect.objectContaining({ code: "entrypoint_invalid", path: "execution.entrypoint" })]),
    });

    const invalidMcp = validateExtensionPackageManifest({
      ...skillManifest(),
      kind: "mcp_adapter",
      execution: {
        mode: "mcp_stdio",
        serverName: "calendar",
        command: "calendar-mcp",
        envRefs: { API_KEY: "not-a-secret-reference" },
      },
    });
    expect(invalidMcp).toMatchObject({
      ok: false,
      failures: expect.arrayContaining([expect.objectContaining({ code: "mcp_env_reference_invalid" })]),
    });
  });

  it("reports malformed manifests as typed failures", () => {
    const result = validateExtensionPackageManifest({
      ...skillManifest(),
      checksum: "not-a-checksum",
      runtime: { id: "kasitek-agent-runtime", versionRange: "not-a-range" },
      unexpected: true,
      dependencies: [{ kind: "skill", id: "booking", versionRange: "1.2.0" }, { kind: "skill", id: "booking", versionRange: "1.2.0" }],
    });

    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.failures.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "unknown_field",
      "checksum_invalid",
      "version_range_invalid",
      "dependency_self_reference",
      "dependency_duplicate",
    ]));
    expect(result.failures.every((entry) => entry.phase === "validation")).toBe(true);
  });

  it("validates permission identifiers and configuration defaults at manifest time", () => {
    const result = validateExtensionPackageManifest({
      ...skillManifest(),
      permissions: ["Calendar Read"],
      configSchema: {
        type: "object",
        properties: { maxResults: { type: "integer", default: "ten" } },
      },
    });

    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "permission_invalid" }),
      expect.objectContaining({ code: "config_schema_invalid", path: "configSchema.properties.maxResults.default" }),
    ]));
  });

  it("is ready only when runtime, trust, dependency, permission, and configuration gates pass", () => {
    const validated = validateExtensionPackageManifest(skillManifest());
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const readiness = assessExtensionPackageReadiness(validated.manifest, runtime());

    expect(readiness).toMatchObject({ status: "ready", ready: true, failures: [] });
    expect(readiness.configuration).toEqual({ locale: "en-ZA", maxResults: 10 });
  });

  it("returns typed readiness failures instead of silently executing an unavailable package", () => {
    const result = validateAndAssessExtensionPackage(skillManifest(), runtime({
      runtimeVersion: "1.9.0",
      supportedFeatures: [],
      supportedExecutionModes: ["plugin"],
      trustedChecksums: [],
      installedPackages: [{ kind: "mcp_adapter", id: "calendar", version: "0.4.0", ready: false }],
      grantedPermissions: [],
      configuration: { locale: "fr-FR", maxResults: 99, extra: true },
    }));

    expect(result).toMatchObject({ ok: true, phase: "readiness" });
    if (!result.ok) return;
    expect(result.readiness.failures.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "runtime_version_incompatible",
      "runtime_feature_missing",
      "execution_mode_unsupported",
      "checksum_untrusted",
      "dependency_version_incompatible",
      "permission_not_granted",
      "configuration_enum_invalid",
      "configuration_range_invalid",
      "configuration_unknown_key",
    ]));
    expect(result.readiness.ready).toBe(false);
  });

  it("applies configuration defaults and blocks missing required values or unknown keys", () => {
    const validated = validateExtensionPackageManifest(skillManifest());
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const withDefaults = assessExtensionPackageReadiness(validated.manifest, runtime({ configuration: {} }));
    expect(withDefaults).toMatchObject({ ready: true, configuration: { locale: "en-ZA", maxResults: 5 } });

    const invalid = assessExtensionPackageReadiness(validated.manifest, runtime({ configuration: { locale: "en-ZA", unknown: true } }));
    expect(invalid).toMatchObject({ ready: false, failures: [expect.objectContaining({ code: "configuration_unknown_key" })] });
  });

  it("supports Hermes-style semver ranges and optional dependencies", () => {
    const validated = validateExtensionPackageManifest({
      ...skillManifest(),
      dependencies: [
        { kind: "mcp_adapter", id: "calendar", versionRange: "~1.2.0" },
        { kind: "plugin", id: "optional-crm", versionRange: "^3.0.0", optional: true },
      ],
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const readiness = assessExtensionPackageReadiness(validated.manifest, runtime({
      installedPackages: [{ kind: "mcp_adapter", id: "calendar", version: "1.2.7", ready: true }],
    }));
    expect(readiness).toMatchObject({ ready: true });
  });
});
