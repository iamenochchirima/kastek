import type { MessageRecord } from "../db/repositories/conversation-repository";
import { assessMemorySafety } from "./poisoning";

export const MEMORY_EXTRACTION_VERSION = "deterministic-v1";

export interface ConversationEvidence {
  id: string;
  direction: "inbound" | "outbound" | "system";
  text: string;
  createdAt: string;
}

export interface MemoryCandidate {
  namespace: "agent_private";
  memoryType: "semantic" | "episodic";
  canonicalText: string;
  confidence: number;
  sensitivity: "normal" | "sensitive" | "restricted";
  retentionSuggestion: "standard" | "short" | "long";
  relations: readonly { type: "supports" | "contradicts" | "derived_from"; sourceMessageId: string }[];
  factKey?: string;
  content: {
    category: "preference" | "decision";
    value: string;
  };
  provenance: {
    sourceMessageIds: string[];
    extractionVersion: string;
    extractor: "deterministic";
    model: null;
  };
}

function messageText(message: Pick<MessageRecord, "content">): string {
  const text = message.content?.text;
  if (typeof text === "string" && text.trim()) return text.trim();
  const transcript = message.content?.transcript;
  return typeof transcript === "string" ? transcript.trim() : "";
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function cleanValue(value: string): string {
  return value.replace(/\s+/gu, " ").replace(/[.!?]+$/u, "").trim().slice(0, 240);
}

function candidateKey(category: MemoryCandidate["content"]["category"], value: string): string {
  return `${category}:${normalize(value).slice(0, 180)}`;
}

/**
 * Selects a small, recent evidence window. The selector is deliberately independent of the
 * extractor so a future model adapter cannot silently widen the amount of conversation it sees.
 */
export function selectConversationEvidence(
  messages: readonly MessageRecord[],
  options: { maxMessages?: number; maxCharacters?: number } = {},
): ConversationEvidence[] {
  const maxMessages = Math.max(1, Math.min(options.maxMessages ?? 24, 48));
  const maxCharacters = Math.max(512, Math.min(options.maxCharacters ?? 12_000, 24_000));
  const selected: ConversationEvidence[] = [];
  const seen = new Set<string>();
  let characters = 0;
  for (const message of [...messages].reverse()) {
    if (selected.length >= maxMessages || characters >= maxCharacters) break;
    if (message.direction === "system") continue;
    const text = messageText(message);
    const key = normalize(text);
    if (!key || seen.has(key)) continue;
    const remaining = maxCharacters - characters;
    if (remaining <= 0) break;
    const boundedText = text.slice(0, remaining);
    selected.push({
      id: message.id,
      direction: message.direction as ConversationEvidence["direction"],
      text: boundedText,
      createdAt: message.created_at,
    });
    seen.add(key);
    characters += boundedText.length;
  }
  return selected.reverse();
}

/**
 * Extracts only high-signal user statements. This first adapter is intentionally conservative:
 * it never creates procedural memory and all inferred candidates remain review-pending at the
 * repository boundary. A model-backed extractor can implement the same candidate contract later.
 */
export function extractMemoryCandidates(evidence: readonly ConversationEvidence[]): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];
  const seen = new Set<string>();
  const patterns: Array<{
    category: MemoryCandidate["content"]["category"];
    memoryType: MemoryCandidate["memoryType"];
    confidence: number;
    expression: RegExp;
    prefix: string;
  }> = [
    {
      category: "preference",
      memoryType: "semantic",
      confidence: 0.72,
      expression: /\b(?:i|we)\s+(?:really\s+)?(?:prefer|like|love|hate|usually|always|never|use)\s+(.{3,240}?)(?:[.!?]|$)/iu,
      prefix: "User preference",
    },
    {
      category: "preference",
      memoryType: "semantic",
      confidence: 0.82,
      expression: /\bremember(?:\s+that)?\s+(.{3,240}?)(?:[.!?]|$)/iu,
      prefix: "User-provided fact",
    },
    {
      category: "decision",
      memoryType: "episodic",
      confidence: 0.68,
      expression: /\b(?:we|you and i)\s+(?:agreed|decided|settled)\s+(?:that\s+)?(.{3,240}?)(?:[.!?]|$)/iu,
      prefix: "Conversation decision",
    },
  ];

  for (const item of evidence) {
    if (item.direction !== "inbound") continue;
    // Imported/user text is evidence, not executable instruction. Poisoning
    // signals never become a candidate; sensitive signals remain reviewable
    // but carry an explicit sensitivity classification.
    const safety = assessMemorySafety({ text: item.text, sourceType: "inferred", memoryType: "semantic" });
    if (safety.poisoningSignals.length > 0) continue;
    for (const pattern of patterns) {
      const match = pattern.expression.exec(item.text);
      const value = cleanValue(match?.[1] ?? "");
      if (!value) continue;
      const key = candidateKey(pattern.category, value);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        namespace: "agent_private",
        memoryType: pattern.memoryType,
        canonicalText: `${pattern.prefix}: ${value}`,
        confidence: pattern.confidence,
        sensitivity: safety.sensitiveSignals.length > 0 ? "sensitive" : "normal",
        retentionSuggestion: pattern.category === "decision" ? "standard" : "long",
        relations: [],
        ...(pattern.category === "preference" ? { factKey: key } : {}),
        content: { category: pattern.category, value },
        provenance: {
          sourceMessageIds: [item.id],
          extractionVersion: MEMORY_EXTRACTION_VERSION,
          extractor: "deterministic",
          model: null,
        },
      });
    }
  }
  return candidates;
}
