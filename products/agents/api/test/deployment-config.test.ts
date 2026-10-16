import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function descriptor(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(__dirname, "..", name), "utf8")) as Record<string, unknown>;
}

describe("Agent Platform deployment descriptors", () => {
  it("defines independently deployable API, worker, and gateway process contracts", () => {
    const api = descriptor("railway.api.json");
    const worker = descriptor("railway.worker.json");
    const gateway = descriptor("railway.gateway.json");
    for (const service of [api, worker, gateway]) {
      expect(service.build).toMatchObject({ builder: "DOCKERFILE", dockerfilePath: "products/agents/api/Dockerfile" });
      expect(service.deploy).toMatchObject({ restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 10 });
    }
    expect(api.deploy).toMatchObject({ startCommand: "node dist/http/server.js", healthcheckPath: "/health/ready" });
    expect(worker.deploy).toMatchObject({ startCommand: "node dist/temporal/worker.js" });
    expect(gateway.deploy).toMatchObject({ startCommand: "node dist/gateway/server.js", healthcheckPath: "/health/ready" });
  });
});
