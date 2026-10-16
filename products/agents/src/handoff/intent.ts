/**
 * Versioned, conservative customer intent classification for human handoff.
 *
 * This is deliberately not an LLM decision. A handoff is an ownership change,
 * so only explicit language or a known structured action may authorize it.
 */
export const HANDOFF_CLASSIFIER_VERSION = "v1-en" as const;

export type HandoffIntentKind =
  | "request_human"
  | "confirm_handoff"
  | "decline_handoff"
  | "ambiguous"
  | "other";

export interface HandoffIntent {
  kind: HandoffIntentKind;
  classifierVersion: typeof HANDOFF_CLASSIFIER_VERSION;
  matchedRule: string;
}

type HandoffMessageInput = string | {
  text?: unknown;
  handoffAction?: unknown;
};

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-ZA")
    .replace(/[’']/g, "'")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inputParts(input: HandoffMessageInput): { text: string; action: string | null } {
  if (typeof input === "string") return { text: normalizeText(input), action: null };
  const text = typeof input.text === "string" ? normalizeText(input.text) : "";
  const action = typeof input.handoffAction === "string" ? normalizeText(input.handoffAction).replace(/\s+/g, "_") : null;
  return { text, action };
}

function result(kind: HandoffIntentKind, matchedRule: string): HandoffIntent {
  return { kind, classifierVersion: HANDOFF_CLASSIFIER_VERSION, matchedRule };
}

function isDirectRequest(text: string): boolean {
  if (!text || /^(?:i am|i'm|im|as a) human\b/.test(text)) return false;
  if (/\bhuman resources\b/.test(text)) return false;

  return [
    /\b(?:talk|speak|chat)\s+(?:to|with)\s+(?:a\s+)?(?:human|real person|person|representative|someone)\b/,
    /\b(?:connect|put|transfer|refer|escalate)\b.{0,40}\b(?:human|real person|person|representative|someone)\b/,
    /\b(?:need|want|would like|can i get|can you get me)\b.{0,30}\b(?:a\s+)?(?:human|real person|person|representative|someone)\b/,
    /\b(?:customer service|support representative)\b.{0,24}\b(?:please|now|today|person|representative)\b/,
    /\b(?:please|now)\b.{0,24}\b(?:connect me|transfer me|put me through)\b/,
  ].some((pattern) => pattern.test(text));
}

function isAffirmative(text: string): boolean {
  return /^(?:yes|yeah|yep|yup|sure|okay|ok|please|go ahead|do it|that would be great|connect me|please connect me)(?:\s+(?:please|do that|with them|to a human|to someone))?$/.test(text)
    || /^(?:yes|yeah|yep|yup|sure|okay|ok)\s+please\s+(?:do that|connect me|go ahead)$/.test(text);
}

function isNegative(text: string): boolean {
  return /^(?:no|nope|nah|not now|not yet|no thanks|no thank you|keep helping|continue|keep going|cancel|forget it)(?:\s+(?:please|for now|thanks|thank you|me|me for now))?$/.test(text)
    || /^(?:no thanks|no thank you)\s+keep helping(?: me)?$/.test(text);
}

/**
 * Classify one customer message. `offerPending` is read from durable server
 * state; it is never inferred from the message itself.
 */
export function classifyHandoffIntent(input: HandoffMessageInput, offerPending: boolean): HandoffIntent {
  const { text, action } = inputParts(input);
  if (action === "request_human") return result("request_human", "structured_customer_request");
  if (action === "confirm_handoff") return result("confirm_handoff", "structured_confirm");
  if (action === "decline_handoff") return result("decline_handoff", "structured_decline");
  if (isDirectRequest(text)) return result("request_human", "explicit_customer_request");
  if (!offerPending) return result("other", "no_pending_offer");
  if (isAffirmative(text)) return result("confirm_handoff", "explicit_offer_confirmation");
  if (isNegative(text)) return result("decline_handoff", "explicit_offer_decline");
  return result("ambiguous", "pending_offer_requires_explicit_answer");
}
