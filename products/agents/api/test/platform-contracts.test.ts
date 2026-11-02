import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  agentConfigurationSchema, assertGrantAuthority, assertRuntimeAvailable, assertTaskTransition,
  defaultBusinessConfiguration, executionGrantSchema, executionKindSchema, parseAllowedOrigin, normalizeWebsiteDomain, requestDigest,
  type AdmissionAuthority,
} from "../src/contracts/contracts";

function authorizedRequest() {
  const configuration = defaultBusinessConfiguration();
  configuration.sourceRevisionIds = [randomUUID()];
  const authority: AdmissionAuthority = {
    product: "agents", organizationId: randomUUID(), resourceId: randomUUID(), callerClientId: "agents-execution",
    principal: { kind: "human", issuer: "https://identity.example/realms/kasitek", subject: "user-1" },
  };
  const versionId = randomUUID();
  const grant = executionGrantSchema.parse({
    ...authority, id: randomUUID(), versionId, operations: ["knowledge.read", "model.reply"],
    sourceRevisionIds: configuration.sourceRevisionIds, maxInputBytes: configuration.model.maxInputBytes,
    maxOutputTokens: configuration.model.maxOutputTokens, expiresAt: "2026-10-17T14:00:00Z", revokedAt: null,
  });
  return { authority, configuration, versionId, grant };
}
const now = new Date("2026-10-17T13:00:00Z");

describe("fresh platform execution contract", () => {
  it("leaves token authority unrestricted when omitted while honoring explicit finite grants", () => {
    const { grant, authority, configuration, versionId } = authorizedRequest();
    expect(grant.rootTokenLimit).toBeNull();
    expect(executionGrantSchema.parse({...grant,rootTokenLimit:32000}).rootTokenLimit).toBe(32000);
    const unrestricted = executionGrantSchema.parse({ ...grant, rootTokenLimit: null });
    expect(unrestricted.rootTokenLimit).toBeNull();
    expect(() => assertGrantAuthority(unrestricted, authority, versionId, configuration, now)).not.toThrow();
    expect(() => assertGrantAuthority({ ...unrestricted, operations: [] }, authority, versionId, configuration, now)).toThrow("capabilities");
    for (const rootTokenLimit of [0, -1, Infinity, "unlimited"]) expect(() => executionGrantSchema.parse({ ...grant, rootTokenLimit })).toThrow();
  });
  it("accepts only the two explicit technical categories", () => {
    for (const kind of ["business", "workspace"]) expect(executionKindSchema.parse(kind)).toBe(kind);
    for (const kind of [undefined, "research", "faq", "workflow", "system_hosted", "external_connected"]) {
      expect(executionKindSchema.safeParse(kind).success).toBe(false);
    }
  });

  it("keeps an ordinary FAQ small while denying every unavailable capability", () => {
    expect(agentConfigurationSchema.parse(defaultBusinessConfiguration()).executionKind).toBe("business");
    for (const capability of ["delegation", "sandbox", "businessActions", "workflows", "schedules"] as const) {
      const configuration = defaultBusinessConfiguration();
      (configuration.capabilities[capability] as { enabled: boolean }).enabled = true;
      expect(agentConfigurationSchema.safeParse(configuration).success).toBe(false);
    }
    expect(agentConfigurationSchema.safeParse({ ...defaultBusinessConfiguration(), tools: ["execute"] }).success).toBe(false);
    const hidden = defaultBusinessConfiguration();
    Object.assign(hidden.capabilities.sandbox, { operation: "shell" });
    expect(agentConfigurationSchema.safeParse(hidden).success).toBe(false);
  });

  it("rejects an unavailable workspace adapter without routing it to business", () => {
    const configuration = defaultBusinessConfiguration();
    configuration.executionKind = "workspace";
    expect(() => assertRuntimeAvailable(configuration)).toThrowError(expect.objectContaining({ code: "RUNTIME_UNAVAILABLE" }));
    expect(() => assertRuntimeAvailable(defaultBusinessConfiguration())).not.toThrow();
  });

  it("rejects undeclared model properties and invalid execution limits", () => {
    const configuration = defaultBusinessConfiguration();
    expect(agentConfigurationSchema.safeParse({ ...configuration, model: { ...configuration.model, model: "paid/model" } }).success).toBe(false);
    expect(agentConfigurationSchema.safeParse({ ...configuration, model: { ...configuration.model, maxOutputTokens: -1 } }).success).toBe(false);
  });

  it("admits only authority matching the complete persisted grant", () => {
    const { authority, configuration, versionId, grant } = authorizedRequest();
    expect(() => assertGrantAuthority(grant, authority, versionId, configuration, now)).not.toThrow();
    for (const mismatch of [
      { organizationId: randomUUID() }, { resourceId: randomUUID() }, { product: "growth" as const },
      { callerClientId: "growth" }, { principal: { ...authority.principal, subject: "another-user" } },
    ]) {
      expect(() => assertGrantAuthority(grant, { ...authority, ...mismatch } as AdmissionAuthority, versionId, configuration, now))
        .toThrowError(expect.objectContaining({ code: "GRANT_SCOPE_DENIED" }));
    }
    expect(() => assertGrantAuthority(grant, authority, randomUUID(), configuration, now)).toThrow("does not cover");
  });

  it("rechecks expiry and revocation on resumed work", () => {
    const { authority, configuration, versionId, grant } = authorizedRequest();
    for (const invalid of [
      { ...grant, revokedAt: "2026-10-17T12:59:00Z" },
      { ...grant, expiresAt: now.toISOString() },
    ]) expect(() => assertGrantAuthority(invalid, authority, versionId, configuration, now))
      .toThrowError(expect.objectContaining({ code: "GRANT_INACTIVE" }));
  });

  it("rejects knowledge, model operations and budgets outside the grant", () => {
    const { authority, configuration, versionId, grant } = authorizedRequest();
    for (const invalid of [
      { ...grant, sourceRevisionIds: [] }, { ...grant, operations: ["model.reply"] as const },
      { ...grant, operations: ["knowledge.read"] as const }, { ...grant, maxOutputTokens: 1 },
      { ...grant, maxInputBytes: 1 },
    ]) expect(() => assertGrantAuthority(invalid as typeof grant, authority, versionId, configuration, now))
      .toThrowError(expect.objectContaining({ code: "GRANT_CAPABILITY_DENIED" }));
  });

  it("does not equate a cancellation request with a confirmed cancellation", () => {
    expect(() => assertTaskTransition("running", "cancel_requested")).not.toThrow();
    expect(() => assertTaskTransition("cancel_requested", "completed")).not.toThrow();
    expect(() => assertTaskTransition("cancel_requested", "cancelled")).not.toThrow();
    for (const terminal of ["completed", "failed", "cancelled", "uncertain"] as const) {
      expect(() => assertTaskTransition(terminal, "running")).toThrow("Cannot move task");
    }
  });

  it("deduplicates semantic JSON while detecting changed request content", () => {
    expect(requestDigest({ input: "hello", scope: { a: 1, b: 2 } }))
      .toBe(requestDigest({ scope: { b: 2, a: 1 }, input: "hello" }));
    expect(requestDigest({ input: "hello" })).not.toBe(requestDigest({ input: "different" }));
  });

  it("normalizes website domain input without relaxing request-origin validation", () => {
    expect(normalizeWebsiteDomain(" kasitek.co.za ")).toBe("https://kasitek.co.za");
    expect(normalizeWebsiteDomain("WWW.KASITEK.CO.ZA/")).toBe("https://www.kasitek.co.za");
    expect(normalizeWebsiteDomain("https://kasitek.co.za:443/")).toBe("https://kasitek.co.za");
    expect(normalizeWebsiteDomain("http://localhost:3000")).toBe("http://localhost:3000");
    for (const value of ["", "*", "*.kasitek.co.za", "%2a.kasitek.co.za", "http://kasitek.co.za", "kasitek.co.za/path", "user:secret@kasitek.co.za", "kasitek.co.za?x=1", "kasitek.co.za#fragment", "//kasitek.co.za", "kasitek.co.za\\path", "kasi tek.co.za", "ftp://kasitek.co.za"]) {
      expect(() => normalizeWebsiteDomain(value)).toThrow();
    }
    expect(() => parseAllowedOrigin("kasitek.co.za")).toThrow();
  });

  it("accepts exact HTTPS origins and local development, without wildcards or URL paths", () => {
    expect(parseAllowedOrigin("https://example.com/")).toBe("https://example.com");
    expect(parseAllowedOrigin("http://localhost:3100")).toBe("http://localhost:3100");
    for (const origin of ["null", "*", "http://example.com", "https://example.com/path", "https://user:secret@example.com", "https://example.com?q=a"]) {
      expect(() => parseAllowedOrigin(origin)).toThrow();
    }
  });
});
