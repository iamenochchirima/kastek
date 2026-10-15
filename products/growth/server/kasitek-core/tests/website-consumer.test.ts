import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as tcpServer } from "node:net";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createHmac } from "node:crypto";
import { parse } from "dotenv";
import pg from "pg";
import { isolatedDatabase } from "./helpers/database-fixture.js";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { installPgTimestampParsers } from "../src/db.js";
import { registerWebsiteRoutes } from "../src/routes/website.js";
import {
  createAgentWebsiteDeployment,
  recordAgentWebsiteDelivery,
} from "../src/services/website/index.js";
const url = process.env.CORE_WEBSITE_CONSUMER_TEST_DATABASE_URL;
async function freePort() {
  const server = tcpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
test(
  "compiled Labs quote/waitlist forms and actual embedded loader/frame preserve native Core delivery and binary audio contracts",
  { skip: !url, timeout: 90000 },
  async () => {
    installPgTimestampParsers();
    const inspector = new pg.Pool({ connectionString: url });
    const names = (
      await inspector.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename~'^[A-Za-z_]+$' AND tablename<>'_prisma_migrations'`,
      )
    ).rows.map((row) => row.tablename);
    await inspector.end();
    const fixture = await isolatedDatabase(url!, "website_consumer", names),
      media = await mkdtemp(join(tmpdir(), "kasitek-widget-fixture-"));
    const siteDir = resolve("../../../kasitek-labs/apps/labs-site");
    assert.ok(
      existsSync(resolve(siteDir, ".next/BUILD_ID")),
      "Build actual Labs site first",
    );
    const sitePort = await freePort(),
      corePort = await freePort(),
      site = `http://127.0.0.1:${sitePort}`,
      coreUrl = `http://127.0.0.1:${corePort}`;
    const calls: { body: any; claims: any }[] = [];
    let audioAsset = "";
    const provider = createServer(async (req, res) => {
      try {
        const [encoded, signature] = String(req.headers.authorization)
          .slice(7)
          .split(".");
        assert.equal(
          signature,
          createHmac("sha256", "synthetic-widget-secret")
            .update(encoded!)
            .digest("base64url"),
        );
        const claims = JSON.parse(
          Buffer.from(encoded!, "base64url").toString(),
        );
        assert.equal(claims.organizationId, "fixture-org");
        assert.equal(claims.audience, "fixture-agents");
        assert.ok(claims.expiresAt > Math.floor(Date.now() / 1000));
        res.setHeader("content-type", "application/json");
        if (req.url === "/v1/channels/inbound") {
          let raw = "";
          for await (const chunk of req) raw += chunk;
          const body = JSON.parse(raw);
          calls.push({ body, claims });
          assert.deepEqual(claims.scopes, ["channels:ingest"]);
          if (body.content.mediaKind === "audio") {
            audioAsset = body.content.assetId;
            res.writeHead(202);
            return res.end('{"jobId":"fixture-audio-job","status":"queued"}');
          }
          await recordAgentWebsiteDelivery(
            fixture.pool,
            "fixture-org",
            body.externalConversationId,
            "fixture-delivery",
            "Synthetic widget reply",
            [],
          );
          res.writeHead(202);
          return res.end('{"accepted":true}');
        }
        if (req.url === "/v1/audio/transcription-jobs/fixture-audio-job") {
          assert.deepEqual(claims.scopes, ["chat:read"]);
          return res.end(
            JSON.stringify({
              id: "fixture-audio-job",
              assetId: audioAsset,
              status: "completed",
              transcript: "Synthetic audio transcript",
            }),
          );
        }
        res.writeHead(404);
        res.end("{}");
      } catch (error) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(error) }));
      }
    });
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
    const emails: unknown[] = [];
    const core = await buildApp(
      {
        pool: fixture.pool,
        config: readConfig({
          DATABASE_URL: url!,
          ENVIRONMENT: "test",
          LOG_LEVEL: "silent",
          FRONTEND_URL: site,
          KASITEK_CORE_PUBLIC_URL: coreUrl,
          KASITEK_MEDIA_STORAGE_PATH: media,
          AGENTS_API_URL: providerUrl,
          AGENTS_INTERNAL_AUTH_SECRET: "synthetic-widget-secret",
          AGENTS_INTERNAL_AUTH_AUDIENCE: "fixture-agents",
        }),
      },
      [
        (app, context) =>
          registerWebsiteRoutes(app, context, {
            sendEmail: async (_core, to, subject, text) => {
              emails.push({ to, subject, text });
            },
          }),
      ],
    );
    await core.listen({ host: "127.0.0.1", port: corePort });
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    };
    for (const file of [
      ".env",
      ".env.local",
      ".env.production",
      ".env.production.local",
    ])
      if (existsSync(resolve(siteDir, file)))
        for (const name of Object.keys(
          parse(readFileSync(resolve(siteDir, file))),
        ))
          env[name] = "";
    Object.assign(env, {
      CORE_API_BASE_URL: coreUrl,
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_ENV: "production",
    });
    const nextModule = pathToFileURL(
      resolve(siteDir, "node_modules/next/dist/server/next.js"),
    ).href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import http from 'node:http';const next=(await import(${JSON.stringify(nextModule)})).default;const app=next({dev:false,dir:${JSON.stringify(siteDir)}});await app.prepare();const server=http.createServer(app.getRequestHandler());server.listen(${sitePort},'127.0.0.1');process.on('SIGTERM',async()=>{server.close();await app.close();process.exit(0);});`,
      ],
      { cwd: siteDir, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let logs = "";
    child.stdout?.on("data", (chunk) => (logs += chunk));
    child.stderr?.on("data", (chunk) => (logs += chunk));
    let browser: any;
    try {
      await fixture.pool.query(
        `INSERT INTO "User"(id,email,"updatedAt")VALUES('fixture-owner','owner@example.test',NOW());INSERT INTO "Organization"(id,name,slug,"ownerId","updatedAt")VALUES('fixture-org','Synthetic widget','fixture-widget','fixture-owner',NOW())`,
      );
      await createAgentWebsiteDeployment(
        fixture.pool,
        "fixture-org",
        "fixture-installation",
        "fixture-connection",
        "fixture-public",
        "fixture-owner",
        {
          displayName: "Synthetic widget",
          allowedOrigins: [site],
          welcomeText: "Fixture welcome",
        },
      );
      const deadline = Date.now() + 30000;
      let ready = false;
      while (Date.now() < deadline && child.exitCode === null) {
        try {
          if ((await fetch(site + "/get-quote")).status === 200) {
            ready = true;
            break;
          }
        } catch {}
        await delay(100);
      }
      assert.ok(ready, "Labs site failed to start: " + logs);
      const { chromium } = await import(
        pathToFileURL(
          resolve(
            "../../client/apps/client/node_modules/@playwright/test/index.mjs",
          ),
        ).href
      );
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      context.setDefaultTimeout(7000);
      await context.route("**/*", (route: any) =>
        [site, coreUrl].includes(new URL(route.request().url()).origin)
          ? route.continue()
          : route.abort(),
      );
      const page = await context.newPage();
      await page.goto(site + "/get-quote");
      await page
        .getByLabel("Business name *", { exact: true })
        .fill("Synthetic site quote");
      await page
        .getByRole("combobox", { name: /Business type/ })
        .selectOption("professional_services");
      await page.getByPlaceholder("Full name").fill("Synthetic Person");
      await page
        .getByLabel("Phone or WhatsApp number", { exact: true })
        .fill("0731234567");
      await page
        .getByLabel("Email *", { exact: true })
        .fill("quote@example.test");
      await page.getByRole("button", { name: /AI agents/ }).click();
      await page
        .getByRole("button", { name: "Request a quote", exact: true })
        .click();
      await page
        .getByRole("status")
        .getByText("Received.", { exact: true })
        .waitFor();
      const quote = (
        await fixture.pool.query(
          `SELECT * FROM "QuoteRequest" WHERE email='quote@example.test'`,
        )
      ).rows[0];
      assert.equal(quote.businessName, "Synthetic site quote");
      assert.equal(quote.contactPerson, "Synthetic Person");
      assert.equal(quote.phone, "+27731234567");
      assert.deepEqual(quote.services, ["custom_ai_chatbots"]);
      await page.goto(site + "/waitlist");
      await page.getByPlaceholder("Full name").fill("Synthetic applicant");
      await page
        .getByLabel("Email *", { exact: true })
        .fill("waitlist@example.test");
      await page.getByRole("button", { name: /Growth workflows/ }).click();
      await page.getByRole("checkbox").check();
      await page
        .getByRole("button", { name: "Apply for early access", exact: true })
        .click();
      await page
        .getByRole("status")
        .getByText("Thank you for applying.", { exact: true })
        .waitFor();
      const waitlist = (
        await fixture.pool.query(
          `SELECT * FROM "ProductWaitlistEntry" WHERE email='waitlist@example.test'`,
        )
      ).rows[0];
      assert.equal(waitlist.contactPerson, "Synthetic applicant");
      assert.deepEqual(waitlist.products, ["kasitek_product_growth"]);
      assert.ok(waitlist.contactConsentAt instanceof Date);
      assert.equal(emails.length, 2);
      const denied = await fetch(
        coreUrl + "/api/widget/v1/deployments/fixture-public",
        { headers: { origin: "https://denied.example.test" } },
      );
      assert.equal(denied.status, 404);
      assert.equal(calls.length, 0);
      await page.evaluate((coreUrl: string) => {
        const script = document.createElement("script");
        script.src = coreUrl + "/api/widget/v1/loader.js";
        script.dataset.kasitekDeployment = "fixture-public";
        document.body.append(script);
      }, coreUrl);
      const launcher = page.getByRole("button", {
        name: "Open Synthetic widget chat",
      });
      await launcher.waitFor();
      await launcher.click();
      const frame = page.frameLocator('iframe[title="Synthetic widget chat"]');
      await frame.locator("#input").fill("Synthetic browser message");
      await frame
        .locator("#form")
        .evaluate((form: HTMLFormElement) => form.requestSubmit());
      await frame
        .getByText("Synthetic widget reply", { exact: true })
        .waitFor();
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.body.content.text, "Synthetic browser message");
      assert.match(calls[0]!.claims.actorId, /^website-session:/);
      const sessions = (
        await fixture.pool.query(`SELECT * FROM "AgentWebsiteVisitorSession"`)
      ).rows;
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].origin, site);
      const bytes = Buffer.from("1a45dfa300ff0180", "hex");
      await frame
        .locator("#file-input")
        .setInputFiles({
          name: "fixture audio.webm",
          mimeType: "audio/webm",
          buffer: bytes,
        });
      await frame
        .getByText("Transcript: Synthetic audio transcript", { exact: true })
        .waitFor();
      assert.equal(calls.length, 2);
      assert.equal(calls[1]!.claims.actorId, "fixture-owner");
      assert.equal(calls[1]!.body.content.mediaKind, "audio");
      const asset = (
        await fixture.pool.query(
          `SELECT * FROM "ContentMediaAsset" WHERE id=$1`,
          [audioAsset],
        )
      ).rows[0];
      assert.equal(asset.orgId, "fixture-org");
      assert.equal(asset.mimeType, "audio/webm");
      assert.equal(asset.metadata.source, "website_widget");
      assert.deepEqual(await readFile(join(media, asset.storageKey)), bytes);
      const wrong = await fetch(
        coreUrl +
          `/api/widget/v1/sessions/${sessions[0].publicSessionId}/deliveries`,
        { headers: { origin: "https://denied.example.test" } },
      );
      assert.equal(wrong.status, 404);
      assert.equal(calls.length, 2);
    } finally {
      await browser?.close();
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await Promise.race([exited, delay(3000)]);
        if (child.exitCode === null) {
          child.kill("SIGKILL");
          await exited;
        }
      }
      await core.close();
      provider.closeAllConnections();
      await new Promise<void>((r) => provider.close(() => r()));
      await fixture.close();
      await rm(media, { recursive: true, force: true });
    }
  },
);
