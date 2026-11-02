import { describe, expect, it } from "vitest";
import profiles from "../src/adapters/models/provider-profiles.json";
import { builtinProviderRegistry, getProviderDefinition, parseProviderRegistry } from "../src/adapters/models/registry";

const copy = () => structuredClone(profiles);

describe("reviewed inference provider registry", () => {
  it("loads data snapshots independently of credential and adapter installation", () => {
    expect(parseProviderRegistry(JSON.stringify(profiles))).toEqual(builtinProviderRegistry);
    expect(builtinProviderRegistry.map(provider => provider.id)).toEqual([
      "openrouter", "openai", "anthropic", "google", "xai", "deepseek", "mistral", "groq", "together", "fireworks", "moonshot", "zai",
    ]);
    expect(builtinProviderRegistry.filter(provider => provider.adapter.readiness === "installed").map(provider => provider.id)).toEqual(builtinProviderRegistry.map(provider => provider.id));
    expect(getProviderDefinition("missing")).toBeUndefined();
    expect(getProviderDefinition("anthropic")).toMatchObject({
      protocol: "anthropic_messages", auth: { kind: "header", headerName: "x-api-key" },
    });
    expect(getProviderDefinition("google")).toMatchObject({
      protocol: "google_generate_content", auth: { kind: "header", headerName: "x-goog-api-key" },
    });
    expect(getProviderDefinition("openai")?.protocol).toBe("openai_responses");
    expect(getProviderDefinition("fireworks")?.discovery.kind).toBe("curated");
    expect(getProviderDefinition("zai")?.discovery.kind).toBe("curated");
  });

  it("isolates parsed snapshots and freezes nested records", () => {
    const input = copy();
    const registry = parseProviderRegistry(input);
    input[0]!.name = "Edited";
    expect(registry[0]!.name).toBe("OpenRouter");
    for (const value of [registry, registry[0], registry[0]!.auth, registry[0]!.discovery, registry[0]!.adapter]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it("allows new reviewed provider data without changing source dispatch", () => {
    const input = copy();
    input.push({ ...input[0]!, id: "reviewed-provider", name: "Reviewed provider", baseUrl: "https://inference.example.com/v1" });
    const registry = parseProviderRegistry(input);
    expect(getProviderDefinition("reviewed-provider", registry)?.adapter.readiness).toBe("installed");
    expect(getProviderDefinition("reviewed-provider")).toBeUndefined();
  });

  it.each([
    "http://api.example.com", "file:///etc/passwd", "https://user:password@api.example.com",
    "https://api.example.com?api_key=secret", "https://api.example.com/#secret",
  ])("rejects endpoint credentials and unsafe URL syntax: %s", endpoint => {
    const input = copy();
    input[0]!.baseUrl = endpoint;
    expect(() => parseProviderRegistry(input)).toThrow();
  });

  it("rejects duplicate identities, unknown protocols, executable fields and secret data", () => {
    const duplicate = copy();
    duplicate.push(duplicate[0]!);
    expect(() => parseProviderRegistry(duplicate)).toThrow("unique");
    for (const change of [
      { protocol: "arbitrary_http" }, { module: "node:child_process" }, { apiKey: "private-key" },
      { auth: { kind: "bearer", secret: "private-key" } },
      { auth: { kind: "header", headerName: "x-api-key\r\nInjected: true" } },
      { adapter: { id: "arbitrary", revision: "1", readiness: "verified" } },
      { capabilities: { tools: true } }, { officialDocsUrl: "http://docs.example.com" },
    ]) {
      expect(() => parseProviderRegistry([{ ...copy()[0], ...change }])).toThrow();
    }
    expect(() => parseProviderRegistry("{invalid-json")).toThrow();
    expect(() => parseProviderRegistry({ providers: profiles })).toThrow();
  });

  it.each(["//evil.example/models", "/../models", "/models?token=secret", "https://evil.example/models"])(
    "rejects discovery paths that escape the reviewed base: %s", path => {
      expect(() => parseProviderRegistry([{ ...copy()[0], discovery: { kind: "models_endpoint", path } }])).toThrow();
    },
  );
});
