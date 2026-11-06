import { generateKeyPairSync, randomUUID } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { GrowthServiceAuth } from "../src/adapters/products/growth-service-auth";
import { requestDigest } from "../src/contracts/contracts";

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
const issuer = "https://growth.example.test";
const actorIssuer = `${issuer}/identity`;
const auth = new GrowthServiceAuth({ issuer, actorIssuer, keys: { "growth-v1": publicPem } });

async function token(command: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ product: "growth", requestDigest: requestDigest(command) })
    .setProtectedHeader({ alg: "RS256", kid: "growth-v1" })
    .setIssuer(issuer).setAudience("agents-product-api").setSubject("growth-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(randomUUID())
    .sign(await importPKCS8(privatePem, "RS256"));
}

const command = () => ({
  version: "1", requestId: randomUUID(), actor: { issuer: actorIssuer, subject: "growth-user-1" },
  workspaceId: randomUUID(), agentId: randomUUID(), operation: "webhook.deliver",
  grantId: randomUUID(), agentsConnectionId: randomUUID(), provider: "facebook", providerAssetId: "page-1",
  event: { kind: "message", assetId: "page-1", eventId: "mid-1", externalConversationId: "page-1:person-1",
    senderId: "person-1", occurredAt: null, providerMessageId: "mid-1", attachments: [], echo: false, text: "Hello" },
});

describe("Growth-managed channel relay authentication", () => {
  it("accepts the verified Growth actor and a signature bound to the full event command", async () => {
    const body = command();
    const verified = await auth.verify(await token(body), body);
    expect(verified.clientId).toBe("growth-api");
  });

  it("rejects an event whose actor issuer differs from Growth's trusted identity namespace", async () => {
    const body = command();
    const signed = await token(body);
    const changed = { ...body, actor: { issuer: "https://attacker.example.test/identity", subject: "growth-user-1" } };
    await expect(auth.verify(signed, changed)).rejects.toMatchObject({ code: "PRODUCT_SERVICE_DENIED" });
  });

  it("rejects a changed payload even when the service token is otherwise valid", async () => {
    const body = command();
    const signed = await token(body);
    const changed = { ...body, event: { ...(body.event as object), text: "Changed after signing" } };
    await expect(auth.verify(signed, changed)).rejects.toMatchObject({ code: "PRODUCT_SERVICE_DENIED" });
  });
});
