import { ToolRegistry } from "../tools/registry";
import {
  ToolPolicyError,
  type ToolInvocationLifecycle,
  type CapabilityManifest,
  type ToolInvocationRequest,
  type ToolInvocationResult,
} from "../tools/types";
import { redactToolOutput } from "../tools/redaction";

export type CapabilityReadiness = "ready" | "not_configured" | "unhealthy" | "not_granted";

export interface CapabilityResolution {
  status: CapabilityReadiness;
  manifest?: Omit<CapabilityManifest, "handler">;
  reason?: string;
}

/**
 * Optional host policy at the capability seam. It is intentionally smaller
 * than the full activity dependency graph: callers provide one admission
 * decision, while this module consistently applies it before invocation.
 */
export interface CapabilityAdmission {
  admit(input: {
    request: ToolInvocationRequest;
    manifest: Omit<CapabilityManifest, "handler">;
  }): Promise<CapabilityResolution>;
}

export interface CapabilityRuntime {
  readonly registry: ToolRegistry;
  resolve(name: string, grantedTools: ReadonlySet<string>): CapabilityResolution;
  list(grantedTools?: ReadonlySet<string>): ReturnType<ToolRegistry["list"]>;
  get(name: string): ReturnType<ToolRegistry["get"]>;
  invoke(request: ToolInvocationRequest): Promise<ToolInvocationResult>;
}

export type { ToolInvocationLifecycle };

function readinessFor(
  registry: ToolRegistry,
  name: string,
  grantedTools: ReadonlySet<string>,
): CapabilityResolution {
  const manifest = registry.get(name);
  if (!manifest) return { status: "not_configured", reason: "TOOL_NOT_FOUND" };
  if (!grantedTools.has(name)) return { status: "not_granted", reason: "TOOL_NOT_GRANTED" };
  if (manifest.manifest?.availability === "not_configured") {
    return { status: "not_configured", reason: "CAPABILITY_NOT_CONFIGURED" };
  }
  if (manifest.manifest?.availability === "unhealthy") {
    return { status: "unhealthy", reason: "CAPABILITY_UNHEALTHY" };
  }
  return { status: "ready", manifest: manifest.manifest ? manifest as Omit<CapabilityManifest, "handler"> : undefined };
}

function policyError(resolution: CapabilityResolution, name: string): ToolPolicyError {
  const code = resolution.reason
    ?? (resolution.status === "not_granted" ? "TOOL_NOT_GRANTED"
      : resolution.status === "unhealthy" ? "CAPABILITY_UNHEALTHY"
        : "CAPABILITY_NOT_CONFIGURED");
  return new ToolPolicyError(code, `Capability is ${resolution.status.replaceAll("_", " ")}: ${name}`);
}

/**
 * One capability seam for manifest lookup, readiness, host admission, and
 * invocation. Durable receipts and operation evidence are supplied by the
 * operation kernel while this module guarantees those callers cannot skip
 * readiness or host authorization.
 */
export function createCapabilityRuntime(input: {
  registry: ToolRegistry;
  admission?: CapabilityAdmission;
}): CapabilityRuntime {
  return {
    registry: input.registry,
    resolve: (name, grantedTools) => readinessFor(input.registry, name, grantedTools),
    list: (grantedTools) => input.registry.list(grantedTools),
    get: (name) => input.registry.get(name),
    invoke: async (request) => {
      const resolution = readinessFor(input.registry, request.name, request.grantedTools);
      if (resolution.status !== "ready") throw policyError(resolution, request.name);
      const rawManifest = input.registry.get(request.name);
      if (!rawManifest) throw policyError({ status: "not_configured", reason: "TOOL_NOT_FOUND" }, request.name);
      if (input.admission) {
        const admitted = await input.admission.admit({
          request,
          manifest: rawManifest.manifest ? rawManifest as Omit<CapabilityManifest, "handler"> : { ...rawManifest, manifest: {
            ownerService: "legacy",
            requiredScope: "legacy",
            execution: "immediate",
            idempotency: "optional",
            approval: rawManifest.requiresApproval ? "policy" : "none",
            auditClassification: "access",
            redaction: [],
          } },
        });
        if (admitted.status !== "ready") throw policyError(admitted, request.name);
      }
      const lifecycle = request.lifecycle;
      const manifest = rawManifest as Omit<CapabilityManifest, "handler">;
      try {
        const prepared = await lifecycle?.prepare({ request, manifest });
        if (prepared?.status === "completed") {
          if (!prepared.result) throw new ToolPolicyError("CAPABILITY_REPLAY_RESULT_MISSING", `Durable result is missing: ${request.name}`);
          return prepared.result;
        }
        if (prepared?.status === "unknown") {
          throw new ToolPolicyError("CAPABILITY_OUTCOME_UNKNOWN", `Capability outcome is unknown: ${request.name}`);
        }
        const result = await input.registry.invoke(request);
        await lifecycle?.complete({
          request,
          manifest,
          result,
          redactedOutput: redactToolOutput(result.output, rawManifest.manifest?.redaction ?? []),
        });
        return result;
      } catch (error) {
        if (lifecycle) {
          await lifecycle.fail({
            request,
            manifest,
            error: {
              code: error instanceof ToolPolicyError ? error.code : "CAPABILITY_INVOCATION_FAILED",
              message: error instanceof Error ? error.message : "Capability invocation failed",
            },
          }).catch(() => undefined);
        }
        throw error;
      }
    },
  };
}
