import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvalsConfig } from "./config.js";
import { parseAgentProfileSpec } from "./agent-profile-service.js";
import type { AgentProfileSpec } from "./profile-store.js";

export interface AgentTemplate {
  key: string;
  name: string;
  description: string;
  spec: AgentProfileSpec;
}

export class AgentTemplateError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentTemplateError";
  }
}

function invalid(message: string): never {
  throw new AgentTemplateError(500, "template_invalid", message);
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") invalid(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) invalid(`${name} is invalid`);
  return normalized;
}

export async function loadAgentTemplates(directory: string): Promise<AgentTemplate[]> {
  let fileNames: string[];
  try {
    fileNames = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const templates: AgentTemplate[] = [];
  const keys = new Set<string>();
  for (const file of fileNames) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(directory, file), "utf8"));
    } catch {
      invalid(`Could not parse agent template ${file}`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      invalid(`Agent template ${file} must be an object`);
    }
    const input = raw as Record<string, unknown>;
    const key = text(input.key, `${file}.key`, 80);
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(key)) {
      invalid(`Agent template key is invalid: ${key}`);
    }
    if (keys.has(key)) invalid(`Agent template key is duplicated: ${key}`);
    keys.add(key);
    let spec: AgentProfileSpec;
    try {
      spec = parseAgentProfileSpec(input.spec);
    } catch (error) {
      invalid(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    templates.push({
      key,
      name: text(input.name, `${file}.name`, 120),
      description: text(input.description, `${file}.description`, 500),
      spec,
    });
  }
  return templates.sort((left, right) => left.name.localeCompare(right.name));
}

export async function listAgentTemplates(config: EvalsConfig): Promise<AgentTemplate[]> {
  return loadAgentTemplates(join(config.repoRoot, "services/evals/templates/agents"));
}
