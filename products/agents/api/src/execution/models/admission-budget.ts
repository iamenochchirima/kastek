import type { AcceptedModelRoutes } from "../../contracts/model-bindings";

type Route = AcceptedModelRoutes["primary"];

/** A zero-priced model spends no plan credits, so the token allowance must not block it. */
export function isFreeModel(route: Route): boolean {
  const pricing = route.model.pricing;
  return Boolean(pricing) &&
    (pricing!.inputMicrosPerMillionTokens ?? 0) === 0 &&
    (pricing!.outputMicrosPerMillionTokens ?? 0) === 0;
}

export function hasKnownPrice(route: Route): boolean {
  return Boolean(route.model.pricing);
}

/**
 * Conservative dollar reservation for one root task: the whole root token budget at the
 * higher of the input and output price. Zero for free or unpriced models.
 */
export function reservationMicros(route: Route): bigint {
  const pricing = route.model.pricing;
  if (!pricing) return 0n;
  const inputPrice = BigInt(pricing.inputMicrosPerMillionTokens ?? 0);
  const outputPrice = BigInt(pricing.outputMicrosPerMillionTokens ?? 0);
  const price = inputPrice > outputPrice ? inputPrice : outputPrice;
  if (price === 0n) return 0n;
  const tokens = BigInt(route.policy.maxRootTokens ?? (route.policy.maxInputTokens ?? 0) + (route.policy.maxOutputTokens ?? 0));
  return (tokens * price) / 1_000_000n;
}
