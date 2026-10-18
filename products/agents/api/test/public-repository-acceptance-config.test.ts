import { describe, expect, it } from "vitest";
import { readPublicRepositoryAcceptanceConfig } from "./support/public-repository-acceptance-config";
const now = Date.parse("2026-10-18T10:00:00Z");
describe("credential-free public acceptance configuration", () => {
  it("uses verified finite defaults without requiring any provider key", () => {
    expect(readPublicRepositoryAcceptanceConfig({}, now)).toEqual({ selection: { owner: "modelcontextprotocol", repository: "typescript-sdk", ref: "main" }, selectedFile: "README.md", expected: "MCP TypeScript SDK", mcpExpected: "Available pages for modelcontextprotocol/typescript-sdk", expiresAt: "2026-11-17T10:00:00.000Z" });
  });
  it("does not adopt or return unrelated private provider credentials", () => {
    expect(readPublicRepositoryAcceptanceConfig({ STASH_AGENT_KEY: "unused", AGENTS_GITHUB_ACCEPTANCE_TOKEN: "unused", GITHUB_TOKEN: "unused" }, now)).toEqual(readPublicRepositoryAcceptanceConfig({}, now));
  });
  it.each(["https://github.com/modelcontextprotocol/typescript-sdk", "owner/repo/extra", "../repo"])("rejects invalid repository %s", repository => {
    expect(() => readPublicRepositoryAcceptanceConfig({ AGENTS_PUBLIC_REPOSITORY_ACCEPTANCE_REPOSITORY: repository }, now)).toThrow("approved public");
  });
  it.each(["https://example.test/main", "main?token=hidden", "main branch"])("rejects a revision override outside the provider policy", ref => {
    expect(() => readPublicRepositoryAcceptanceConfig({ AGENTS_PUBLIC_REPOSITORY_ACCEPTANCE_REF: ref }, now)).toThrow("approved public");
  });
  it.each(["/README.md", "docs/../README.md", "README.md\nheader"])("rejects invalid path %s", selectedFile => {
    expect(() => readPublicRepositoryAcceptanceConfig({ AGENTS_PUBLIC_REPOSITORY_ACCEPTANCE_FILE: selectedFile }, now)).toThrow("relative public file");
  });
  it.each(["", "x".repeat(201), "text\nheader"])("rejects unbounded expected text", expected => {
    expect(() => readPublicRepositoryAcceptanceConfig({ AGENTS_PUBLIC_REPOSITORY_MCP_EXPECT: expected }, now)).toThrow("bounded exact");
  });
  it.each(["2026-10-19", "2026-10-18T10:00:00Z", "2027-10-19T10:00:00Z"])("rejects invalid local expiry %s", expiresAt => {
    expect(() => readPublicRepositoryAcceptanceConfig({ AGENTS_PUBLIC_REPOSITORY_CONNECTION_EXPIRES_AT: expiresAt }, now)).toThrow("local public connection expiry");
  });
});
