import { z } from "zod";

export const evaluationAssertionSchema = z.object({
  path: z.string().trim().min(1).max(240),
  operator: z.enum(["equals", "contains", "exists", "maxLength"]),
  expected: z.unknown().optional(),
});
export type EvaluationAssertion = z.infer<typeof evaluationAssertionSchema>;

export interface EvaluationFailure {
  assertion: EvaluationAssertion;
  actual: unknown;
  message: string;
}

function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current === null || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

export function evaluateDeterministicAssertions(actual: unknown, assertions: EvaluationAssertion[]): {
  passed: boolean;
  total: number;
  passedCount: number;
  failures: EvaluationFailure[];
} {
  const failures: EvaluationFailure[] = [];
  for (const assertion of assertions) {
    const value = readPath(actual, assertion.path);
    let passed = false;
    if (assertion.operator === "exists") passed = assertion.expected === undefined ? value !== undefined : Boolean(assertion.expected) === (value !== undefined);
    if (assertion.operator === "equals") passed = JSON.stringify(value) === JSON.stringify(assertion.expected);
    if (assertion.operator === "contains") passed = typeof value === "string" && value.includes(String(assertion.expected ?? ""));
    if (assertion.operator === "maxLength") passed = (typeof value === "string" || Array.isArray(value)) && value.length <= Number(assertion.expected);
    if (!passed) failures.push({ assertion, actual: value, message: `Assertion failed at ${assertion.path}` });
  }
  return { passed: failures.length === 0, total: assertions.length, passedCount: assertions.length - failures.length, failures };
}
