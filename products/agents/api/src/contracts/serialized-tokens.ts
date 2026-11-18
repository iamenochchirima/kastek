/**
 * Model-facing token accounting for serialized provider payloads.
 *
 * Measured against OpenRouter input counts: schema-heavy requests serialize at 3.03-3.27 UTF-8
 * bytes per provider token. Dividing by the lower bound keeps the estimate equal to or slightly
 * above the observed count, so window, compaction and reservation guards stay conservative while
 * no longer treating bytes as tokens (which overstated usage by about 3x).
 *
 * `nativeCorrection` carries the measured difference between a real prepared-payload count and
 * this estimate; it is expressed in the same estimated-token unit.
 */
export const ESTIMATED_BYTES_PER_TOKEN = 3;

export function estimatedTokensFromSerialized(serializedBytes: number, nativeCorrection = 0): number {
  if (!Number.isSafeInteger(serializedBytes) || serializedBytes < 0 ||
      !Number.isSafeInteger(nativeCorrection) || nativeCorrection < 0) {
    throw new RangeError("Serialized size and native correction must be non-negative integers");
  }
  return nativeCorrection + Math.ceil(serializedBytes / ESTIMATED_BYTES_PER_TOKEN);
}
