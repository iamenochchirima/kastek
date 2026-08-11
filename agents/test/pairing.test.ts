import { describe, expect, it } from "vitest";
import { createPairingToken, hashPairingToken, isPairingTokenExpired } from "../src/channels/pairing";

describe("channel pairing tokens", () => {
  it("only persists a hash and expires bounded one-time tokens", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const token = createPairingToken(60, now);
    expect(token.token).not.toBe(token.tokenHash);
    expect(hashPairingToken(token.token)).toBe(token.tokenHash);
    expect(isPairingTokenExpired(token.expiresAt, now)).toBe(false);
    expect(isPairingTokenExpired(token.expiresAt, new Date("2026-01-01T00:01:01Z"))).toBe(true);
  });
});
