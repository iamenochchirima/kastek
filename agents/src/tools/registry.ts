import Ajv, { type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import { createHash } from "node:crypto";
import type {
  CapabilityManifest,
  CapabilityManifestMetadata,
  ToolDefinition,
  ToolInvocationRequest,
  ToolInvocationResult,
} from "./types";
import { ToolPolicyError } from "./types";
import { generateCapabilitySurfaces, type GeneratedCapabilitySurface } from "../capabilities/surfaces";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

export function hashToolArguments(argumentsValue: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(stableValue(argumentsValue))).digest("hex");
}

export function effectIdForInvocation(context: { runId: string }, toolName: string, argumentsHash: string): string {
  return createHash("sha256").update(`${context.runId}:${toolName}:${argumentsHash}`).digest("hex");
}

interface RegisteredTool extends ToolDefinition {
  validateInput: ValidateFunction;
  validateOutput: ValidateFunction;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly ajv: Ajv;

  /** MCP and internal capability schemas use the JSON Schema 2020-12 dialect. */
  public constructor(ajv: Ajv = new Ajv2020({ allErrors: true, strict: false })) {
    this.ajv = ajv;
  }

  public register(definition: ToolDefinition): void {
    if (this.tools.has(definition.name)) throw new Error(`Duplicate tool: ${definition.name}`);
    if (!/^\d+\.\d+\.\d+$/.test(definition.version)) throw new Error(`Invalid tool version: ${definition.name}`);
    if (definition.timeoutMs < 1 || definition.timeoutMs > 120_000) throw new Error(`Invalid timeout for tool: ${definition.name}`);
    const validateInput = this.ajv.compile(definition.inputSchema);
    const validateOutput = this.ajv.compile(definition.outputSchema);
    this.tools.set(definition.name, { ...definition, validateInput, validateOutput });
  }

  public registerManifest(definition: CapabilityManifest & ToolDefinition): void {
    if (!definition.manifest.ownerService.trim()) throw new Error(`Capability owner is required: ${definition.name}`);
    if (!definition.manifest.requiredScope.trim()) throw new Error(`Capability scope is required: ${definition.name}`);
    if (!definition.manifest.redaction.every((entry) => entry.trim().length > 0)) throw new Error(`Capability redaction metadata is invalid: ${definition.name}`);
    this.register(definition);
  }

  public list(grantedTools?: ReadonlySet<string>): Array<Omit<ToolDefinition, "handler">> {
    return [...this.tools.values()]
      .filter((tool) => !grantedTools || grantedTools.has(tool.name))
      .map(({ handler: _handler, validateInput: _input, validateOutput: _output, ...manifest }) => manifest);
  }

  public get(name: string): Omit<ToolDefinition, "handler"> | undefined {
    const tool = this.tools.get(name);
    if (!tool) return undefined;
    const { handler: _handler, validateInput: _input, validateOutput: _output, ...manifest } = tool;
    return manifest;
  }

  public validateArguments(name: string, argumentsValue: Record<string, unknown>): boolean {
    const tool = this.tools.get(name);
    return Boolean(tool?.validateInput(argumentsValue));
  }

  public manifests(grantedTools?: ReadonlySet<string>): Array<Omit<CapabilityManifest, "handler">> {
    return [...this.tools.values()]
      .filter((tool) => tool.manifest && (!grantedTools || grantedTools.has(tool.name)))
      .map(({ handler: _handler, validateInput: _input, validateOutput: _output, ...manifest }) => manifest as Omit<CapabilityManifest, "handler">);
  }

  public surfaces(grantedTools?: ReadonlySet<string>): GeneratedCapabilitySurface[] {
    return generateCapabilitySurfaces(this.manifests(grantedTools));
  }

  public async invoke(request: ToolInvocationRequest): Promise<ToolInvocationResult> {
    const tool = this.tools.get(request.name);
    if (!tool) throw new ToolPolicyError("TOOL_NOT_FOUND", `Tool is not registered: ${request.name}`);
    if (!tool.validateInput(request.arguments)) {
      throw new ToolPolicyError("INVALID_TOOL_ARGUMENTS", `Arguments failed the schema for ${request.name}`);
    }
    if (!request.grantedTools.has(tool.name)) {
      throw new ToolPolicyError("TOOL_NOT_GRANTED", `Tool is not granted: ${request.name}`);
    }
    const argumentsHash = hashToolArguments(request.arguments);
    if (tool.requiresApproval) {
      const approval = request.approval;
      if (!approval || approval.argumentsHash !== argumentsHash) {
        throw new ToolPolicyError("APPROVAL_REQUIRED", `Tool requires approval: ${request.name}`);
      }
      if (Date.parse(approval.expiresAt) <= Date.now()) {
        throw new ToolPolicyError("APPROVAL_EXPIRED", `Approval expired for ${request.name}`);
      }
    }
    const startedAt = Date.now();
    if (tool.riskClass === "external-effect") await request.beforeEffect?.();
    const context = request.signal ? { ...request.context, signal: request.signal } : request.context;
    const output = await Promise.race([
      tool.handler(context, request.arguments),
      new Promise<never>((_, reject) => setTimeout(() => reject(new ToolPolicyError("TOOL_TIMEOUT", `Tool timed out: ${request.name}`)), tool.timeoutMs)),
      ...(request.signal ? [new Promise<never>((_, reject) => {
        if (request.signal?.aborted) {
          reject(new ToolPolicyError("TOOL_CANCELLED", `Tool cancelled: ${request.name}`));
          return;
        }
        request.signal?.addEventListener("abort", () => reject(new ToolPolicyError("TOOL_CANCELLED", `Tool cancelled: ${request.name}`)), { once: true });
      })] : []),
    ]);
    if (!tool.validateOutput(output)) {
      throw new ToolPolicyError("INVALID_TOOL_OUTPUT", `Output failed the schema for ${request.name}`);
    }
    return {
      name: tool.name,
      version: tool.version,
      argumentsHash,
      output,
      control: output && typeof output === "object" && ["awaiting_human", "final_response"].includes(String((output as Record<string, unknown>).control))
        ? (output as { control: "awaiting_human" | "final_response" }).control
        : undefined,
      effectId: tool.riskClass === "external-effect" ? effectIdForInvocation(request.context, tool.name, argumentsHash) : undefined,
      latencyMs: Date.now() - startedAt,
    };
  }
}
