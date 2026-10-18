import { describe, expect, it } from "vitest";
import { readStashAcceptanceConfig } from "./support/stash-acceptance-config";
const now = Date.parse("2026-10-18T10:00:00Z");
const valid = { STASH_AGENT_KEY: "fixture_explicit_key_not_a_credential", AGENTS_STASH_ACCEPTANCE_ITEM_ID: "e7c268fe-b115-4365-b50f-b7690acfce07", AGENTS_STASH_ACCEPTANCE_EXPECT: "Exact approved research passage" };
describe("Stash acceptance preflight without I/O", () => {
  it("requires an explicit item and quote while setting only a local authorization expiry", () => {
    expect(readStashAcceptanceConfig(valid, now)).toEqual({ token: valid.STASH_AGENT_KEY, itemId: valid.AGENTS_STASH_ACCEPTANCE_ITEM_ID, expected: valid.AGENTS_STASH_ACCEPTANCE_EXPECT, expiresAt: "2026-11-17T10:00:00.000Z" });
  });
  it("accepts an explicit bounded local expiry without a provider token expiry", () => {
    expect(readStashAcceptanceConfig({ ...valid, AGENTS_STASH_CONNECTION_EXPIRES_AT: "2026-10-19T10:00:00Z" }, now).expiresAt).toBe("2026-10-19T10:00:00Z");
  });
  it("does not adopt other credentials, implicit project notes or invented expected text", () => {
    expect(() => readStashAcceptanceConfig({ ...valid, STASH_AGENT_KEY: undefined, STASH_API_KEY: valid.STASH_AGENT_KEY }, now)).toThrow("approved STASH_AGENT_KEY");
    expect(() => readStashAcceptanceConfig({ ...valid, AGENTS_STASH_ACCEPTANCE_ITEM_ID: undefined }, now)).toThrow("explicitly approved");
    expect(() => readStashAcceptanceConfig({ ...valid, AGENTS_STASH_ACCEPTANCE_EXPECT: undefined }, now)).toThrow("exact expected");
  });
  it.each(["2026-10-19", "2026-10-18T10:00:00Z", "2027-10-19T10:00:00Z", "invalid"])("rejects invalid local expiry %s", expiresAt => {
    expect(() => readStashAcceptanceConfig({ ...valid, AGENTS_STASH_CONNECTION_EXPIRES_AT: expiresAt }, now)).toThrow("local connection expiry");
  });
  it.each(["short", "x".repeat(201), "Exact expected text\nAuthorization: hidden"])("rejects invalid expected content", expected => {
    expect(() => readStashAcceptanceConfig({ ...valid, AGENTS_STASH_ACCEPTANCE_EXPECT: expected }, now)).toThrow("exact expected");
  });
  it("keeps rejected key bytes out of errors", () => {
    const token = "private_stash_key\nheader-injection";
    try { readStashAcceptanceConfig({ ...valid, STASH_AGENT_KEY: token }, now); throw Error("unexpected acceptance"); }
    catch (error) { expect((error as Error).message).toContain("approved STASH_AGENT_KEY"); expect((error as Error).message).not.toContain(token); expect((error as Error).message).not.toContain("header-injection"); }
  });
});
