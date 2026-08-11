import Ajv, { type ValidateFunction } from "ajv";
import { createHash } from "node:crypto";
import type {
  ToolDefinition,
  ToolInvocationRequest,
  ToolInvocationResult,
} from "./types";
import { ToolPolicyError } from "./types";

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

interface RegisteredTool extends ToolDefinition {
  validateInput: ValidateFunction;
  validateOutput: ValidateFunction;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly ajv: Ajv;

  public constructor(ajv = new Ajv({ allErrors: true, strict: false })) {
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
    const output = await Promise.race([
      tool.handler(request.context, request.arguments),
      new Promise<never>((_, reject) => setTimeout(() => reject(new ToolPolicyError("TOOL_TIMEOUT", `Tool timed out: ${request.name}`)), tool.timeoutMs)),
    ]);
    if (!tool.validateOutput(output)) {
      throw new ToolPolicyError("INVALID_TOOL_OUTPUT", `Output failed the schema for ${request.name}`);
    }
    return {
      name: tool.name,
      version: tool.version,
      argumentsHash,
      output,
      latencyMs: Date.now() - startedAt,
    };
  }
}
