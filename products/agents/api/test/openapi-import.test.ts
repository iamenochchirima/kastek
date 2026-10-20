import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { compileOpenApiRequest, importOpenApiDocument, injectOpenApiCredentials, OPENAPI_LIMITS,
  type RequestArguments, type RequestTemplate } from "../src/adapters/providers/openapi";
import { requestDigest } from "../src/contracts/contracts";

const serverUrl = "https://api.example.com/v1";
function document(version = "3.1.0") {
  return { openapi: version, info: { title: "Controlled API", version: "1" }, servers: [{ url: serverUrl }],
    paths: { "/records/{id}": { parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", minLength: 1 } }],
      get: { operationId: "readRecord", parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 10 } },
        { name: "tags", in: "query", schema: { type: "array", maxItems: 3, items: { type: "string" } } },
        { name: "x-request-label", in: "header", schema: { type: "string", maxLength: 40 } }],
        responses: { "200": { description: "Record", content: { "application/json": { schema: { type: "object" } } } } } },
      post: { operationId: "updateRecord", requestBody: { required: true, content: { "application/json": { schema: {
        type: "object", required: ["title"], additionalProperties: false, properties: { title: { type: "string", minLength: 1, maxLength: 80 }, count: { type: "integer", minimum: 0 } } } } } }, responses: { "204": { description: "Updated" } } } } } };
}
function operation(source: unknown = document(), index = 0) { return importOpenApiDocument(source, { serverUrl }).operations[index]!; }
function template(source: unknown = document(), index = 0): RequestTemplate {
  const result = operation(source, index);
  expect(result.diagnostics).toEqual([]); expect(result.compatible).toBe(true);
  return result.template!;
}
function replaceGet(get: Record<string, unknown>) {
  const source = document() as Record<string, any>; source.paths["/records/{id}"].get = get; return source;
}
function withSecurity(definition: Record<string, unknown>, requirement: unknown = [{ provider: [] }]) {
  return { ...document(), components: { securitySchemes: { provider: definition } }, security: requirement };
}

describe("bounded OpenAPI import", () => {
  it("requires an explicit supported security alternative without treating an OR choice as combined credentials", () => {
    const source = { ...document(), components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" }, key: { type: "apiKey", in: "header", name: "x-example-key" } } }, security: [{ bearer: [] }, { key: [] }] };
    const initial=importOpenApiDocument(source,{serverUrl});
    expect(initial.operations[0]!.compatible).toBe(false);expect(initial.operations[0]!.securityChoices.map(choice=>choice.security?.type)).toEqual(["bearer","api_key"]);
    const selections=Object.fromEntries(initial.operations.map(operation=>[operation.alias,1]));
    const selected=importOpenApiDocument(source,{serverUrl,securitySelections:selections});
    expect(selected.operations.every(operation=>operation.compatible&&operation.security?.type==="api_key")).toBe(true);
    expect(selected.operations[0]!.template!.security.name).toBe("x-example-key");
    expect(()=>importOpenApiDocument(source,{serverUrl,securitySelections:{[initial.operations[0]!.alias]:7}})).not.toThrow();
    expect(importOpenApiDocument(source,{serverUrl,securitySelections:{[initial.operations[0]!.alias]:7}}).operations[0]!.diagnostics).toContainEqual(expect.objectContaining({code:"OPENAPI_SECURITY_SELECTION_INVALID"}));
    expect(()=>importOpenApiDocument(source,{serverUrl,securitySelections:{["api_"+"a".repeat(32)]:0}})).toThrow("unavailable operation");
  });
  it("bounds repeated server and referenced schema expansion by normalized bytes",()=>{
    const source=document() as Record<string,any>;
    source.servers=[{url:serverUrl},...Array.from({length:200},(_,index)=>({url:"https://server.example.com/"+index+"x".repeat(1800)}))];
    source.paths=Object.fromEntries(Array.from({length:20},(_,index)=>[`/record-${index}`,{get:{operationId:`read-${index}`,responses:{"200":{description:"Ready"}}}}]));
    expect(()=>importOpenApiDocument(source,{serverUrl})).toThrow("Normalized API catalog exceeds byte limits");
  });
  it.each(["3.0.4", "3.1.0"])("imports %s operations without declaring GET safe", version => {
    const imported = importOpenApiDocument(document(version), { serverUrl });
    expect(imported.operations).toHaveLength(2);
    expect(imported.operations.every(entry => entry.compatible && entry.effect === "unknown" && entry.reviewRequired)).toBe(true);
    expect(imported.operations[0]!.responseSchemas[0]!.schema).toEqual({ type: "object" });
    expect(imported.operations[0]!.serverCandidates).toEqual([serverUrl]);
  });
  it("parses bounded YAML without aliases or duplicate keys", () => {
    const yaml = `openapi: 3.1.0\ninfo:\n  title: YAML API\nservers:\n  - url: ${serverUrl}\npaths:\n  /status:\n    get:\n      operationId: status\n      responses:\n        '200':\n          description: Ready\n`;
    expect(importOpenApiDocument(yaml, { serverUrl }).operations[0]!.compatible).toBe(true);
    expect(() => importOpenApiDocument(yaml + "info: {}\n", { serverUrl })).toThrow();
    expect(() => importOpenApiDocument("info: &data {}\npaths: *data\n", { serverUrl })).toThrow();
    expect(() => importOpenApiDocument("x".repeat(OPENAPI_LIMITS.documentBytes + 1), { serverUrl })).toThrow();
  });
  it("resolves internal schemas and parameter overrides while preserving schemas", () => {
    const source = document() as Record<string, any>;
    source.components = { schemas: { Title: { type: "string", minLength: 2, maxLength: 7 } },
      parameters: { Limit: { name: "limit", in: "query", required: true, schema: { type: "integer", minimum: 2 } } } };
    source.paths["/records/{id}"].parameters.push({ name: "limit", in: "query", schema: { type: "integer", maximum: 3 } });
    source.paths["/records/{id}"].get.parameters = [{ $ref: "#/components/parameters/Limit" }];
    source.paths["/records/{id}"].post.requestBody.content["application/json"].schema.properties.title = { $ref: "#/components/schemas/Title" };
    expect(template(source).parameters.find(parameter => parameter.name === "limit")!.schema).toEqual({ type: "integer", minimum: 2 });
    const post = template(source, 1);
    expect(() => compileOpenApiRequest(post, { path: { id: "1" }, body: { title: "x" } })).toThrow();
    expect(compileOpenApiRequest(post, { path: { id: "1" }, body: { title: "valid" } }).body).toBe('{"title":"valid"}');
  });
  it("diagnoses missing IDs with stable aliases and rejects duplicate IDs", () => {
    const source = document() as Record<string, any>;
    delete source.paths["/records/{id}"].get.operationId;
    const first = operation(source);
    expect(first.compatible).toBe(true); expect(first.diagnostics[0]!.code).toBe("OPENAPI_OPERATION_ID_MISSING");
    source.paths["/records/{id}"].get.summary = "Changed description";
    expect(operation(source).alias).toBe(first.alias);
    source.paths["/records/{id}"].get.operationId = "updateRecord";
    expect(importOpenApiDocument(source, { serverUrl }).operations.every(entry => !entry.compatible && entry.template === null)).toBe(true);
  });
  it.each([
    [{ $ref: "https://attacker.example/schema" }, "OPENAPI_REF_UNSUPPORTED"],
    [{ $ref: "#/components/schemas/Missing" }, "OPENAPI_REF_UNRESOLVED"],
    [{ $ref: "#/components/schemas/Recursive" }, "OPENAPI_REF_RECURSIVE"],
    [{ $ref: "#/components/schemas/Plain", maxLength: 1 }, "OPENAPI_REF_SIBLINGS_UNSUPPORTED"],
    [{ type: "string", pattern: "(a+)+$" }, "OPENAPI_SCHEMA_UNSUPPORTED"],
  ])("diagnoses unsupported schema references and constraints", (definition, code) => {
    const source = document() as Record<string, any>;
    source.components = { schemas: { Recursive: { $ref: "#/components/schemas/Recursive" }, Plain: { type: "string" } } };
    source.paths["/records/{id}"].post.requestBody.content["application/json"].schema.properties.title = definition;
    const result = operation(source, 1);
    expect(result.compatible).toBe(false); expect(result.diagnostics.at(-1)!.code).toBe(code);
  });
  it("pins the selected server and refuses operation overrides, variables and encoded traversal", () => {
    const source = document() as Record<string, any>;
    source.servers.push({ url: "https://other.example.com" });
    source.paths["/records/{id}"].get.servers = [{ url: "https://other.example.com" }];
    expect(operation(source).diagnostics[0]!.code).toBe("OPENAPI_SERVER_OVERRIDE_UNSUPPORTED");
    source.paths["/records/{id}"].get.servers = [{ url: serverUrl, variables: {} }];
    expect(operation(source).diagnostics[0]!.code).toBe("OPENAPI_SERVER_VARIABLES_UNSUPPORTED");
    for (const unsafe of ["https://api.example.com/v1/../admin", "https://api.example.com/v1/%2e%2e/admin", "https://user:secret@api.example.com", "https://127.0.0.1", "http://api.example.com", "https://api.example.com?x=1"]) {
      expect(() => importOpenApiDocument(source, { serverUrl: unsafe })).toThrow();
    }
  });
  it("bounds operation counts and rejects cyclic inputs", () => {
    const source = document() as Record<string, any>;
    source.paths = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`/path${index}`, { get: { operationId: `operation${index}` } }]));
    expect(() => importOpenApiDocument(source, { serverUrl })).toThrow(/operation limit/);
    const input = { nested: null as unknown }; input.nested = input;
    expect(() => importOpenApiDocument(input, { serverUrl })).toThrow(/acyclic/);
  });
  it("bounds reference expansion without fetching remote documents", () => {
    const source = document() as Record<string, any>;
    source.components = { schemas: { S0: { type: "string" } } };
    for (let depth = 1; depth < 14; depth++) source.components.schemas[`S${depth}`] = {
      type: "object", properties: { left: { $ref: `#/components/schemas/S${depth - 1}` }, right: { $ref: `#/components/schemas/S${depth - 1}` } },
    };
    source.paths["/records/{id}"].post.requestBody.content["application/json"].schema = { $ref: "#/components/schemas/S13" };
    expect(operation(source, 1).diagnostics.at(-1)!.code).toBe("OPENAPI_LIMIT");
  });
  it("reports unsupported serialization and authentication combinations precisely", () => {
    expect(operation(replaceGet({ operationId: "read", parameters: [{ name: "filter", in: "query", style: "deepObject", schema: { type: "object" } }] })).compatible).toBe(false);
    const bearer = { type: "http", scheme: "bearer" };
    const alternatives = operation(withSecurity(bearer, [{ provider: [] }, {}]));
    expect(alternatives.diagnostics[0]!.code).toBe("OPENAPI_SECURITY_ALTERNATIVES_UNSUPPORTED");
    expect(alternatives.securityRequirements).toEqual([{ provider: [] }, {}]);
    expect(operation(withSecurity(bearer, [{ provider: [], second: [] }])).diagnostics[0]!.code).toBe("OPENAPI_SECURITY_COMBINED_UNSUPPORTED");
    expect(operation(withSecurity({ type: "apiKey", in: "cookie", name: "session" })).diagnostics[0]!.code).toBe("OPENAPI_SECURITY_UNSUPPORTED");
  });
});

describe("reviewed structured request compilation", () => {
  it("compiles scalar and array parameters with a fixed base path and bounded JSON body", () => {
    const compiled = compileOpenApiRequest(template(), { path: { id: "record 1" }, query: { limit: 5, tags: ["a&b", "c"] }, headers: { "x-request-label": "case 1" } });
    const url = new URL(compiled.url);
    expect(url.origin).toBe("https://api.example.com"); expect(url.pathname).toBe("/v1/records/record%201");
    expect(url.searchParams.getAll("tags")).toEqual(["a&b", "c"]); expect(url.searchParams.get("limit")).toBe("5");
    expect(compiled.headers["x-request-label"]).toBe("case 1"); expect(compiled.reviewRequired).toBe(true);
    expect(compileOpenApiRequest(template(undefined, 1), { path: { id: "1" }, body: { title: "Hello", count: 0 } }).headers["content-type"]).toBe("application/json");
  });
  it.each(["..", ".", "%2e%2e", "a/b", "a\\b", "//attacker.example", "?x=1", "#fragment", "{url}"])("rejects path injection %s", id => {
    expect(() => compileOpenApiRequest(template(), { path: { id } })).toThrow();
  });
  it.each([
    { path: { id: "1" }, query: { limit: 11 } }, { path: { id: "1" }, query: { limit: "5" } },
    { path: { id: "1" }, headers: { "x-request-label": "valid\r\nHost: attacker" } },
    { path: { id: "1" }, headers: { Host: "attacker" } }, { path: { id: "1" }, query: { access_token: "injected" } },
    { path: { id: "1" }, body: { title: "data" } }, { query: { limit: 3 } },
  ])("rejects invalid inputs before producing a destination", input => {
    expect(() => compileOpenApiRequest(template(), input as RequestArguments)).toThrow();
  });
  it("validates required, nested and additional body properties without evaluating text", () => {
    const reviewed = template(undefined, 1);
    for (const body of [{}, { title: "" }, { title: "good", extra: true }, { title: "good", count: -1 }, { title: "good", access_token: "bad" }]) {
      expect(() => compileOpenApiRequest(reviewed, { path: { id: "1" }, body })).toThrow();
    }
    expect(compileOpenApiRequest(reviewed, { path: { id: "1" }, body: { title: "${process.env.SECRET}" } }).body).toBe('{"title":"${process.env.SECRET}"}');
    expect(() => compileOpenApiRequest({ ...reviewed, path: "/replacement" }, { body: { title: "valid" } })).toThrow(/changed/);
  });
  it("keeps nullable and enum constraints independent", () => {
    const source = document("3.0.4") as Record<string, any>;
    source.paths["/records/{id}"].post.requestBody.content["application/json"].schema.properties.title = { type: "string", nullable: true, enum: ["allowed"] };
    const reviewed = template(source, 1);
    expect(() => compileOpenApiRequest(reviewed, { path: { id: "1" }, body: { title: null } })).toThrow();
    source.paths["/records/{id}"].post.requestBody.content["application/json"].schema.properties.title.enum.push(null);
    expect(compileOpenApiRequest(template(source, 1), { path: { id: "1" }, body: { title: null } }).body).toBe('{"title":null}');
  });
  it.each([
    [{ type: "http", scheme: "bearer" }, { type: "bearer", token: "vault-token" }, "authorization", "Bearer vault-token"],
    [{ type: "http", scheme: "basic" }, { type: "basic", username: "service", password: "vault-password" }, "authorization", `Basic ${Buffer.from("service:vault-password").toString("base64")}`],
    [{ type: "apiKey", in: "header", name: "X-Service-Key" }, { type: "api_key", value: "vault-key" }, "x-service-key", "vault-key"],
  ])("injects authentication only from a trusted reference", (definition, credential, header, value) => {
    const reviewed = template(withSecurity(definition as Record<string, unknown>));
    expect(() => compileOpenApiRequest(reviewed, { path: { id: "1" } })).toThrow(/credential reference/);
    const compiled = compileOpenApiRequest(reviewed, { path: { id: "1" } }, { provider: "vault:reference" });
    expect(JSON.stringify(compiled)).not.toContain("vault-token"); expect(compiled.headers.authorization).toBeUndefined();
    const authorized = injectOpenApiCredentials(compiled, { "vault:reference": credential as any });
    expect(authorized.headers[header as string]).toBe(value); expect(compiled.headers[header as string]).toBeUndefined();
  });
  it("keeps query credentials out of model arguments and rejects credential controls", () => {
    const reviewed = template(withSecurity({ type: "apiKey", in: "query", name: "service_key" }));
    const compiled = compileOpenApiRequest(reviewed, { path: { id: "1" } }, { provider: "vault:query" });
    expect(new URL(compiled.url).searchParams.has("service_key")).toBe(false);
    expect(new URL(injectOpenApiCredentials(compiled, { "vault:query": { type: "api_key", value: "s&a=b" } }).url).searchParams.get("service_key")).toBe("s&a=b");
    expect(() => injectOpenApiCredentials(compiled, { "vault:query": { type: "api_key", value: "bad\r\nvalue" } })).toThrow();
    expect(() => compileOpenApiRequest(reviewed, { path: { id: "1" }, query: { service_key: "model-key" } }, { provider: "vault:query" })).toThrow();
  });
  it("delivers the compiled request to an explicit controlled HTTP fixture", async () => {
    const fixture = createServer(async (request, response) => {
      const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ method: request.method, path: request.url, authorization: request.headers.authorization, body: Buffer.concat(parts).toString("utf8") }));
    });
    fixture.listen(0, "127.0.0.1"); await once(fixture, "listening");
    try {
      const port = (fixture.address() as { port: number }).port, localServer = `http://127.0.0.1:${port}/v1`;
      const source = withSecurity({ type: "http", scheme: "bearer" }); source.servers = [{ url: localServer }];
      expect(() => importOpenApiDocument(source, { serverUrl: localServer })).toThrow();
      const reviewed = importOpenApiDocument(source, { serverUrl: localServer, testLoopback: true }).operations[1]!.template!;
      const request = injectOpenApiCredentials(compileOpenApiRequest(reviewed, { path: { id: "1" }, body: { title: "Fixture write" } }, { provider: "vault:fixture" }),
        { "vault:fixture": { type: "bearer", token: "controlled-token" } });
      const result = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body, redirect: "error" }).then(response => response.json());
      expect(result).toEqual({ method: "POST", path: "/v1/records/1", authorization: "Bearer controlled-token", body: '{"title":"Fixture write"}' });
    } finally { fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve())); }
  });
});
