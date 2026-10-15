export type MemorySourceTrust = "user_explicit" | "platform_curated" | "organization_curated" | "model_inferred" | "external_untrusted";
export type MemorySafetyStatus = "active" | "review_pending" | "quarantined";

export interface MemorySafetyAssessment {
  sourceTrust: MemorySourceTrust;
  poisoningSignals: string[];
  sensitiveSignals: string[];
  recommendedStatus: MemorySafetyStatus;
  reviewRequired: boolean;
}

const SUSPICIOUS_PATTERNS: Array<[string, RegExp]> = [
  ["instruction_override", /ignore\s+(all\s+)?previous\s+instructions/i],
  ["instruction_override_indirect", /\b(?:from\s+now\s+on|treat\s+(?:this|the)\s+(?:note|document|text)\s+as|follow\s+these\s+instructions|the\s+following\s+instructions)\b/i],
  ["instruction_override_translated", /\b(?:ignora\s+(?:las|todas\s+las)\s+instrucciones|ignorer\s+les\s+instructions|ignoriere\s+(?:die\s+)?vorherigen\s+anweisungen|ignore\s+instrucoes\s+anteriores)\b/i],
  ["secret_exfiltration", /(reveal|send|export)\s+(the\s+)?(secret|token|password|api\s*key)/i],
  ["safety_bypass", /(disable|bypass|circumvent)\s+(safety|policy|approval)/i],
  ["prompt_extraction", /(system\s+prompt|hidden\s+instructions|developer\s+message)/i],
  ["encoded_instruction", /\b(?:base64|rot13|hex(?:adecimal)?|encoded)\b[\s\S]{0,160}\b(?:instruction|ignore|reveal|bypass|system)\b/i],
];

const SENSITIVE_PATTERNS: Array<[string, RegExp]> = [
  ["credential_value", /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_-]{16,}|bearer\s+[A-Za-z0-9._~+/=-]{16,})\b/i],
  ["credential_assignment", /\b(?:api[_ -]?key|password|secret|token)\s*[:=]\s*[^\s,;]+/i],
  ["email_address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ["phone_number", /\b(?:\+?\d[\d ()-]{7,}\d)\b/],
];

function defaultSourceTrust(sourceType: "explicit" | "imported" | "inferred"): MemorySourceTrust {
  if (sourceType === "explicit") return "user_explicit";
  if (sourceType === "imported") return "external_untrusted";
  return "model_inferred";
}

export function detectMemoryPoisoning(text: string): string[] {
  return SUSPICIOUS_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

export function detectSensitiveMemoryContent(text: string): string[] {
  return SENSITIVE_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

export function assessMemorySafety(input: {
  text: string;
  sourceType: "explicit" | "imported" | "inferred";
  memoryType: "working" | "semantic" | "episodic" | "procedural";
  sourceTrust?: MemorySourceTrust;
  reviewRequired?: boolean;
}): MemorySafetyAssessment {
  const sourceTrust = input.sourceTrust ?? defaultSourceTrust(input.sourceType);
  const poisoningSignals = detectMemoryPoisoning(input.text);
  const sensitiveSignals = detectSensitiveMemoryContent(input.text);
  const proceduralViolation = input.memoryType === "procedural" && sourceTrust !== "user_explicit";
  if (proceduralViolation) poisoningSignals.push("untrusted_procedural_memory");
  const reviewRequired = input.reviewRequired === true || sourceTrust === "external_untrusted" || sourceTrust === "model_inferred";
  const recommendedStatus: MemorySafetyStatus = poisoningSignals.length || sensitiveSignals.length
    ? "quarantined"
    : reviewRequired
      ? "review_pending"
      : "active";
  return { sourceTrust, poisoningSignals, sensitiveSignals, recommendedStatus, reviewRequired };
}
