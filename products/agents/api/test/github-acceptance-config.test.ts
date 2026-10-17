import { describe, expect, it } from "vitest";
import { readGithubAcceptanceConfig } from "./support/github-acceptance-config";

const now = Date.parse("2026-10-18T10:00:00Z");
const valid = { AGENTS_GITHUB_ACCEPTANCE_TOKEN: "github_pat_explicit_fixture_not_a_credential", AGENTS_GITHUB_ACCEPTANCE_EXPIRES_AT: "2026-10-19T10:00:00Z" };

describe("real-provider acceptance preflight without allocations or network", () => {
  it("accepts explicit approved configuration and exact public repository defaults", () => {
    expect(readGithubAcceptanceConfig(valid, now)).toMatchObject({ selection: { owner: "github", repository: "github-mcp-server", ref: "main" }, selectedFile: "README.md", expected: "GitHub" });
  });
  it("does not adopt unrelated GitHub credentials or invent a token expiry", () => {
    expect(() => readGithubAcceptanceConfig({ GITHUB_TOKEN: valid.AGENTS_GITHUB_ACCEPTANCE_TOKEN }, now)).toThrow("explicitly approved");
    expect(() => readGithubAcceptanceConfig({ AGENTS_GITHUB_ACCEPTANCE_TOKEN: valid.AGENTS_GITHUB_ACCEPTANCE_TOKEN }, now)).toThrow("actual finite ISO");
  });
  it.each(["2026-10-19", "2026-10-18T10:00:00Z", "2027-10-19T10:00:00Z", "not-an-expiry"])("rejects invalid or unapproved expiry %s before any I/O", expiresAt => {
    expect(() => readGithubAcceptanceConfig({ ...valid, AGENTS_GITHUB_ACCEPTANCE_EXPIRES_AT: expiresAt }, now)).toThrow("actual finite ISO");
  });
  it.each(["https://github.com/github/repo", "owner/repo/extra", "../repo", "owner/.."])("rejects invalid repository selection %s", repository => {
    expect(() => readGithubAcceptanceConfig({ ...valid, AGENTS_GITHUB_ACCEPTANCE_REPOSITORY: repository }, now)).toThrow("approved GitHub");
  });
  it.each(["/README.md", "../README.md", "docs/../README.md", "docs\\README.md", "README.md\nAuthorization: secret"])("rejects invalid file override %s", selectedFile => {
    expect(() => readGithubAcceptanceConfig({ ...valid, AGENTS_GITHUB_ACCEPTANCE_FILE: selectedFile }, now)).toThrow("relative file path");
  });
  it("keeps rejected credential bytes out of the diagnostic", () => {
    const token = "github_pat_private\nheader-injection";
    let message = "";
    try { readGithubAcceptanceConfig({ ...valid, AGENTS_GITHUB_ACCEPTANCE_TOKEN: token }, now); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("explicitly approved");
    expect(message).not.toContain(token);
    expect(message).not.toContain("header-injection");
  });
});
