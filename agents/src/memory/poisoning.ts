const SUSPICIOUS_PATTERNS: Array<[string, RegExp]> = [
  ["instruction_override", /ignore\s+(all\s+)?previous\s+instructions/i],
  ["secret_exfiltration", /(reveal|send|export)\s+(the\s+)?(secret|token|password|api\s*key)/i],
  ["safety_bypass", /(disable|bypass|circumvent)\s+(safety|policy|approval)/i],
  ["prompt_extraction", /(system\s+prompt|hidden\s+instructions|developer\s+message)/i],
];

export function detectMemoryPoisoning(text: string): string[] {
  return SUSPICIOUS_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}
