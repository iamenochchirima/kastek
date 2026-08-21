"use client";

import { Input } from "@/components/ui/input";

export type AgentRuntimeLimitsValue = {
  maxIterations: string;
  maxToolCalls: string;
  maxModelCalls: string;
  maxTotalTokens: string;
  maxContextMessages: string;
  maxContextTokens: string;
  maxWallTimeMs: string;
};

export const defaultAgentRuntimeLimits: AgentRuntimeLimitsValue = {
  maxIterations: "8",
  maxToolCalls: "8",
  maxModelCalls: "8",
  maxTotalTokens: "4096",
  maxContextMessages: "30",
  maxContextTokens: "12000",
  maxWallTimeMs: "60000",
};

function parseLimit(value: string, label: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be a whole number between ${minimum.toLocaleString()} and ${maximum.toLocaleString()}`);
  }
  return parsed;
}

export function parseAgentRuntimeLimits(value: AgentRuntimeLimitsValue) {
  return {
    maxIterations: parseLimit(value.maxIterations, "Max iterations", 1, 100),
    maxToolCalls: parseLimit(value.maxToolCalls, "Max tool calls", 1, 100),
    maxModelCalls: parseLimit(value.maxModelCalls, "Max model calls", 1, 100),
    maxTotalTokens: parseLimit(value.maxTotalTokens, "Max total tokens", 256, 1_000_000),
    maxContextMessages: parseLimit(value.maxContextMessages, "Max context messages", 1, 500),
    maxContextTokens: parseLimit(value.maxContextTokens, "Max context tokens", 256, 200_000),
    maxWallTimeMs: parseLimit(value.maxWallTimeMs, "Max wall time", 1_000, 600_000),
  };
}

export function AgentRuntimeLimits({ value, onChange }: { value: AgentRuntimeLimitsValue; onChange: (value: AgentRuntimeLimitsValue) => void }) {
  const update = (key: keyof AgentRuntimeLimitsValue, next: string) => onChange({ ...value, [key]: next });
  const fields: Array<[keyof AgentRuntimeLimitsValue, string, string]> = [
    ["maxIterations", "Iterations", "1–100"],
    ["maxToolCalls", "Tool calls", "1–100"],
    ["maxModelCalls", "Model calls", "1–100"],
    ["maxTotalTokens", "Total tokens", "256–1,000,000"],
    ["maxContextMessages", "Context messages", "1–500"],
    ["maxContextTokens", "Context tokens", "256–200,000"],
    ["maxWallTimeMs", "Wall time (ms)", "1,000–600,000"],
  ];
  return <div className="rounded-xl border border-border bg-secondary/20 p-4">
    <h2 className="text-sm font-semibold text-foreground">Runtime limits</h2>
    <p className="mt-1 text-xs leading-5 text-muted-foreground">These ceilings apply to every run and are persisted in the published version. Lower limits are safer for testing and can be raised in a new version.</p>
    <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {fields.map(([key, label, range]) => <label key={key} className="text-xs font-medium text-foreground">{label}<span className="ml-1 font-normal text-muted-foreground">({range})</span><Input value={value[key]} onChange={(event) => update(key, event.target.value)} inputMode="numeric" className="mt-1" /></label>)}
    </div>
  </div>;
}
