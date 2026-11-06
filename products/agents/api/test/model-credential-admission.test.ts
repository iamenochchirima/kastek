import { describe, expect, it } from "vitest";
import { payloadContainsModelCredential, responseContainsModelCredential } from "../src/execution/models/credential-admission";

describe("model credential admission", () => {
  it("detects an active model credential in nested prompt text and tool arguments", () => {
    const key = "private-model-key-123456";
    expect(payloadContainsModelCredential({ messages: [{ content: `key: ${key}` }] }, key)).toBe(true);
    expect(payloadContainsModelCredential({ tools: [{ arguments: { key } }] }, key)).toBe(true);
  });
  it("allows ordinary business information and handles short keys without substring overblocking", () => {
    expect(payloadContainsModelCredential({ text: "Order 1042 for customer@example.test" }, "private-model-key-123456")).toBe(false);
    expect(payloadContainsModelCredential({ text: "a key point" }, "key")).toBe(false);
    expect(payloadContainsModelCredential({ text: "key" }, "key")).toBe(true);
  });
  it("detects the active key across stream chunks and inside the private receipt", () => {
    const key = "private-model-key-123456";
    expect(responseContainsModelCredential({ message: "ok" }, ["private-model-", "key-123456"], key)).toBe(true);
    expect(responseContainsModelCredential({ nativeState: { text: key } }, [], key)).toBe(true);
    expect(responseContainsModelCredential({ message: "Order 1042" }, ["Order ", "1042"], key)).toBe(false);
  });
  it("detects common encoded reflections without blocking unrelated content", () => {
    const key = "private/model+credential-123456";
    for (const value of [encodeURIComponent(key), Buffer.from(key).toString("base64"), Buffer.from(key).toString("base64url")]) {
      expect(payloadContainsModelCredential({ text: value }, key)).toBe(true);
    }
    expect(payloadContainsModelCredential({ text: "A public URL https://example.test" }, key)).toBe(false);
  });
});
