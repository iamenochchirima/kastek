export interface AgentBudgetLimits {
  contextTokens: number;
  modelTokens: number;
  toolCalls: number;
  graphSteps: number;
  childInvocations: number;
  wallTimeMs: number;
}

export interface AgentBudgetUsage {
  contextTokens: number;
  modelTokens: number;
  toolCalls: number;
  graphSteps: number;
  childInvocations: number;
  startedAt: number;
}

export interface AgentBudgetLedger {
  readonly limits: Readonly<AgentBudgetLimits>;
  readonly usage: Readonly<AgentBudgetUsage>;
  admit(kind: "context" | "model" | "tool" | "graph" | "child", amount?: number): boolean;
  consume(kind: "context" | "model" | "tool" | "graph" | "child", amount?: number): void;
  snapshot(): { limits: AgentBudgetLimits; usage: AgentBudgetUsage; remainingWallTimeMs: number };
}

export function createAgentBudgetLedger(input: Partial<AgentBudgetLimits> = {}): AgentBudgetLedger {
  const limits: AgentBudgetLimits = {
    contextTokens: finiteLimit(input.contextTokens, 8_000),
    modelTokens: finiteLimit(input.modelTokens, 32_000),
    toolCalls: finiteLimit(input.toolCalls, 16),
    graphSteps: finiteLimit(input.graphSteps, 2_000),
    childInvocations: finiteLimit(input.childInvocations, 16),
    wallTimeMs: finiteLimit(input.wallTimeMs, 60_000),
  };
  const usage: AgentBudgetUsage = { contextTokens: 0, modelTokens: 0, toolCalls: 0, graphSteps: 0, childInvocations: 0, startedAt: Date.now() };
  return {
    limits,
    usage,
    admit(kind, amount = 1) {
      if (!Number.isFinite(amount) || amount < 0) return false;
      if (kind === "tool") return usage.toolCalls + amount <= limits.toolCalls;
      if (kind === "graph") return usage.graphSteps + amount <= limits.graphSteps;
      if (kind === "child") return usage.childInvocations + amount <= limits.childInvocations;
      if (kind === "context") return usage.contextTokens + amount <= limits.contextTokens;
      return usage.modelTokens + amount <= limits.modelTokens && Date.now() - usage.startedAt < limits.wallTimeMs;
    },
    consume(kind, amount = 1) {
      if (!this.admit(kind, amount)) throw new Error(`AGENT_BUDGET_EXCEEDED:${kind}`);
      if (kind === "tool") usage.toolCalls += amount;
      else if (kind === "graph") usage.graphSteps += amount;
      else if (kind === "child") usage.childInvocations += amount;
      else if (kind === "context") usage.contextTokens += amount;
      else usage.modelTokens += amount;
    },
    snapshot() {
      return { limits: { ...limits }, usage: { ...usage }, remainingWallTimeMs: Math.max(0, limits.wallTimeMs - (Date.now() - usage.startedAt)) };
    },
  };
}

function finiteLimit(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value < 0 ? fallback : Math.floor(value);
}
