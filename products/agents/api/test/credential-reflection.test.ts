import { describe, expect, it } from "vitest";
import { containsConnectorCredential } from "../src/capabilities/connected-tools/credential-reflection";

describe("connector credential reflection", () => {
  it("detects the active bearer token without its header and encoded in response text", () => {
    const token = "private-token+value/123456";
    for (const value of [token, encodeURIComponent(token), Buffer.from(token).toString("base64"), Buffer.from(token).toString("base64url"), `Bearer ${token}`]) {
      expect(containsConnectorCredential(Buffer.from(JSON.stringify({ text: value })), `Bearer ${token}`)).toBe(true);
    }
  });
  it("preserves unrelated business data", () => {
    expect(containsConnectorCredential(Buffer.from('{"order":"1042","email":"customer@example.test"}'), "Bearer private-token-123456")).toBe(false);
  });
  it("still rejects exact short authorization reflections", () => {
    expect(containsConnectorCredential(Buffer.from('{"text":"abc"}'), "abc")).toBe(true);
  });
});
