import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parse } from "dotenv";
import { hash } from "bcryptjs";
import pg from "pg";
import type { ServerResponse } from "node:http";
import { isolatedDatabase } from "./helpers/database-fixture.js";
import { buildApp } from "../src-ts/app.js";
import { readConfig } from "../src-ts/config.js";
import { installPgTimestampParsers } from "../src-ts/db.js";
import { registerAdminAuthRoutes } from "../src-ts/routes/admin-auth.js";
import { registerAdminOperationsRoutes } from "../src-ts/routes/admin-operations.js";
const url = process.env.CORE_ADMIN_CONSUMER_TEST_DATABASE_URL;
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
test(
  "compiled Labs Admin reset/login, scoped CRM/import, CSV/PDF and activity SSE reach native TypeScript Core",
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
    const fixture = await isolatedDatabase(url!, "admin_consumer", names);
    const adminDir = resolve("../../../kasitek-labs/apps/admin-site");
    assert.ok(
      existsSync(resolve(adminDir, ".next/BUILD_ID")),
      "Build the actual Admin app before running this compiled consumer fixture",
    );
    const frontPort = await freePort(),
      front = `http://127.0.0.1:${frontPort}`;
    const mailMessages: { Text?: string; To?: { Email?: string }[] }[] = [];
    const mailSink = createHttpServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        if (request.method !== "POST" || request.url !== "/api/v1/send") {
          response.writeHead(404).end();
          return;
        }
        mailMessages.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    mailSink.listen(0, "127.0.0.1");
    await once(mailSink, "listening");
    const mailPort = (mailSink.address() as { port: number }).port;
    const core = await buildApp(
      {
        pool: fixture.pool,
        config: readConfig({
          DATABASE_URL: url!,
          ENVIRONMENT: "test",
          LOG_LEVEL: "silent",
          FRONTEND_URL: front,
          ADMIN_FRONTEND_URL: front,
          LOCAL_MAILPIT_URL: `http://127.0.0.1:${mailPort}`,
        }),
      },
      [registerAdminAuthRoutes, registerAdminOperationsRoutes],
    );
    let streamClosed = false;
    const streams = new Set<ServerResponse>();
    core.addHook("onSend", async (request, reply, payload) => {
      if (request.routeOptions.url === "/api/admin/activity/stream") {
        streams.add(reply.raw);
        reply.raw.once("close", () => {
          streams.delete(reply.raw);
          streamClosed = true;
        });
      }
      return payload;
    });
    const coreUrl = await core.listen({ host: "127.0.0.1", port: 0 });
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    };
    // Do not let the Admin process use local provider secrets or existing connections.
    for (const file of [".env", ".env.local"])
      if (existsSync(resolve(adminDir, file)))
        for (const name of Object.keys(
          parse(readFileSync(resolve(adminDir, file))),
        ))
          env[name] = "";
    Object.assign(env, {
      CORE_BACKEND_URL: coreUrl,
      TENANTS_BACKEND_URL: "http://127.0.0.1:1",
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_ENV: "production",
      AUTH_SECRET: "synthetic-admin-fixture-only",
    });
    const nextModule = pathToFileURL(
      resolve(adminDir, "node_modules/next/dist/server/next.js"),
    ).href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import http from 'node:http';const next=(await import(${JSON.stringify(nextModule)})).default;const app=next({dev:false,dir:${JSON.stringify(adminDir)}});await app.prepare();const server=http.createServer(app.getRequestHandler());server.listen(${frontPort},'127.0.0.1');process.on('SIGTERM',async()=>{server.close();await app.close();process.exit(0);});`,
      ],
      { cwd: adminDir, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let logs = "";
    child.stdout?.on("data", (chunk) => (logs += chunk));
    child.stderr?.on("data", (chunk) => (logs += chunk));
    const cookies = new Map<string, string>();
    const request = async (
      path: string,
      init: RequestInit = {},
      authenticated = true,
    ) => {
      const headers = new Headers(init.headers);
      if (authenticated && cookies.size)
        headers.set(
          "cookie",
          [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
        );
      const response = await fetch(front + path, {
        ...init,
        headers,
        redirect: "manual",
      });
      for (const raw of response.headers.getSetCookie()) {
        const pair = raw.split(";")[0]!,
          index = pair.indexOf("=");
        cookies.set(pair.slice(0, index), pair.slice(index + 1));
      }
      return response;
    };
    const post = (path: string, body: unknown, authenticated = true) =>
      request(
        path,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        authenticated,
      );
    try {
      const password = await hash("synthetic-fixture-password", 4);
      await fixture.pool.query(
        `INSERT INTO "AdminUser"(id,name,email,password,role,"updatedAt") VALUES('fixture-admin','Fixture admin','admin@example.test',$1,'admin',NOW()),('fixture-viewer','Fixture viewer','viewer@example.test',$1,'viewer',NOW())`,
        [password],
      );
      const deadline = Date.now() + 30000;
      let ready = false;
      while (Date.now() < deadline && child.exitCode === null) {
        try {
          if ((await request("/api/leads", {}, false)).status === 401) {
            ready = true;
            break;
          }
        } catch {}
        await delay(100);
      }
      assert.ok(
        ready,
        "Compiled Admin did not start: " +
          logs.replace(/postgres(?:ql)?:\/\/\S+/g, "[redacted]"),
      );
      assert.equal((await request("/forgot-password", {}, false)).status, 200);
      const forgot = await post(
        "/api/core/admin/forgot-password",
        { email: "admin@example.test" },
        false,
      );
      assert.equal(forgot.status, 200);
      assert.equal(mailMessages.length, 1);
      assert.equal(mailMessages[0]!.To?.[0]?.Email, "admin@example.test");
      const resetUrl = new URL(
        String(mailMessages[0]!.Text).split(": ").slice(1).join(": "),
      );
      assert.equal(resetUrl.origin, front);
      assert.equal(resetUrl.pathname, "/reset-password");
      assert.equal(resetUrl.searchParams.get("email"), "admin@example.test");
      assert.equal(
        (
          await request(
            `/reset-password?${resetUrl.searchParams.toString()}`,
            {},
            false,
          )
        ).status,
        200,
      );
      const reset = await post(
        "/api/core/admin/reset-password",
        {
          email: resetUrl.searchParams.get("email"),
          token: resetUrl.searchParams.get("token"),
          password: "synthetic-reset-password",
        },
        false,
      );
      assert.equal(reset.status, 200);
      assert.equal(
        (
          await post(
            "/api/core/admin/reset-password",
            {
              email: resetUrl.searchParams.get("email"),
              token: resetUrl.searchParams.get("token"),
              password: "synthetic-replay-password",
            },
            false,
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await post(
            "/api/core/admin/login",
            { email: "admin@example.test", password: "wrong" },
            false,
          )
        ).status,
        401,
      );
      assert.equal(
        (
          await post(
            "/api/core/admin/login",
            { email: "admin@example.test", password: "synthetic-fixture-password" },
            false,
          )
        ).status,
        401,
      );
      const login = await post(
        "/api/core/admin/login",
        { email: "admin@example.test", password: "synthetic-reset-password" },
        false,
      );
      assert.equal(login.status, 200);
      assert.equal((await login.json()).id, "fixture-admin");
      const cookie = login.headers.get("set-cookie")!;
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /SameSite=lax/i);
      assert.equal(cookies.get("kasitek_admin_session"), "fixture-admin");
      const lead = await post("/api/leads", {
        businessName: "Synthetic consumer company",
        contactPerson: "Fixture Person",
        phone: "555",
        email: "contact@example.test",
        businessType: "fixture",
        services: ["website"],
        quoteAmount: 12.5,
      });
      assert.equal(lead.status, 201);
      const record = await lead.json();
      assert.ok(record.id);
      assert.equal(record.business_name, "Synthetic consumer company");
      const read = await request("/api/leads?search=consumer");
      assert.equal(read.status, 200);
      assert.equal((await read.json()).length, 1);
      const mutation = await request(`/api/leads/${record.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "contacted" }),
      });
      assert.equal(mutation.status, 200);
      assert.equal((await mutation.json()).status, "contacted");
      assert.equal(
        (
          await fixture.pool.query(
            `SELECT status FROM "QuoteRequest" WHERE id=$1`,
            [record.id],
          )
        ).rows[0].status,
        "contacted",
      );
      const imported = await post("/api/outreach/import", {
        category: "synthetic",
        name: "Synthetic import",
        listings: [
          {
            name: "Fixture listing",
            website: "https://example.test",
            phone: "555",
          },
        ],
      });
      assert.equal(imported.status, 201);
      const campaign = await imported.json();
      assert.ok(campaign.id);
      assert.equal(
        (
          await fixture.pool.query(
            `SELECT count(*)::int AS count FROM "OutreachLead" WHERE "campaignId"=$1`,
            [campaign.id],
          )
        ).rows[0].count,
        1,
      );
      const document = {
        businessName: "Synthetic consumer company",
        contactPerson: "Fixture Person",
        contactEmail: "contact@example.test",
        contactPhone: "555",
        date: "2026-10-02",
        title: "Synthetic document",
        pricingItems: [
          { description: "Fixture setup", amount: "R 123.45", billing: "Once" },
        ],
        sectionOrder: ["intro"],
        noteSections: [{ title: "Fixture note" }],
      };
      const quotation = await post("/api/quotations", document);
      assert.equal(quotation.status, 201);
      const quotationRecord = await quotation.json();
      assert.equal(quotationRecord.business_name, document.businessName);
      assert.equal(quotationRecord.businessName, undefined);
      const { coreQuotationDraftRecord } = await import(
        pathToFileURL(resolve(adminDir, "src/lib/core-quotation-record.ts"))
          .href
      );
      const draftRecord = coreQuotationDraftRecord(quotationRecord);
      assert.equal(draftRecord.businessName, document.businessName);
      assert.equal(draftRecord.contactPerson, document.contactPerson);
      assert.equal(draftRecord.contactEmail, document.contactEmail);
      assert.equal(draftRecord.contactPhone, document.contactPhone);
      assert.equal(draftRecord.title, document.title);
      assert.deepEqual(draftRecord.pricingItems, document.pricingItems);
      const quotationPdf = await request(
        `/api/quotations/${quotationRecord.id}/pdf`,
      );
      assert.equal(quotationPdf.status, 200);
      assert.equal(quotationPdf.headers.get("content-type"), "application/pdf");
      assert.match(
        quotationPdf.headers.get("content-disposition")!,
        /attachment; filename=.*quotation\.pdf/,
      );
      const quotationBytes = Buffer.from(await quotationPdf.arrayBuffer());
      assert.equal(quotationBytes.subarray(0, 5).toString(), "%PDF-");
      const quotationText = quotationBytes.toString("latin1");
      for (const value of [
        document.businessName,
        document.contactEmail,
        document.title,
        "Fixture setup",
        "R 123.45",
      ])
        assert.ok(
          quotationText.includes(value),
          `Quotation PDF must include persisted value ${value}`,
        );
      const invoice = await post("/api/invoices", {
        ...document,
        billingMode: "one_off",
      });
      assert.equal(invoice.status, 201);
      const invoiceRecord = await invoice.json();
      assert.equal(invoiceRecord.businessName, document.businessName);
      assert.equal(invoiceRecord.business_name, undefined);
      const invoicePdf = await request(`/api/invoices/${invoiceRecord.id}/pdf`);
      assert.equal(invoicePdf.status, 200);
      assert.equal(invoicePdf.headers.get("content-type"), "application/pdf");
      const invoiceBytes = Buffer.from(await invoicePdf.arrayBuffer());
      assert.equal(invoiceBytes.subarray(0, 5).toString(), "%PDF-");
      for (const value of [
        document.businessName,
        document.contactEmail,
        document.title,
        "Fixture setup",
        "R 123.45",
      ])
        assert.ok(
          invoiceBytes.toString("latin1").includes(value),
          `Invoice PDF must include persisted value ${value}`,
        );
      const csv = await request(
        "/api/reports/export?report=platform-overview&days=7",
      );
      assert.equal(csv.status, 200);
      assert.match(csv.headers.get("content-type")!, /^text\/csv/);
      assert.match(
        csv.headers.get("content-disposition")!,
        /attachment; filename=/,
      );
      assert.match(await csv.text(), /^date,/);
      const outreachCsv = await request("/api/outreach/delivery/export?days=7");
      assert.equal(outreachCsv.status, 200);
      assert.match(outreachCsv.headers.get("content-type")!, /^text\/csv/);
      assert.match(
        outreachCsv.headers.get("content-disposition")!,
        /outreach-delivery-.*\.csv/,
      );
      assert.ok((await outreachCsv.text()).includes(","));
      const controller = new AbortController();
      const stream = await request("/api/activity/stream?days=7&limit=2", {
        signal: controller.signal,
      });
      assert.equal(stream.status, 200);
      assert.match(stream.headers.get("content-type")!, /^text\/event-stream/);
      const reader = stream.body!.getReader();
      const first = await reader.read();
      assert.ok(first.value?.length);
      const text = new TextDecoder().decode(first.value);
      assert.match(text, /(?:event: activity|: heartbeat)/);
      assert.doesNotMatch(text, /event: error/);
      controller.abort();
      await reader.cancel().catch(() => {});
      const closeDeadline = Date.now() + 3000;
      while (!streamClosed && Date.now() < closeDeadline) await delay(25);
      assert.equal(
        streamClosed,
        true,
        "Admin browser cancellation must close the upstream Core activity stream",
      );
      assert.equal(
        (
          await request(
            "/api/reports/export?report=platform-overview",
            {},
            false,
          )
        ).status,
        401,
      );
      // CRM source handlers authorize a valid Admin session, without a viewer-role
      // write restriction. Report mutation/export handlers have a stricter role gate.
      assert.equal(
        (await post("/api/leads", { businessName: "Denied" }, false)).status,
        401,
      );
      assert.equal(
        (
          await post(
            "/api/outreach/import",
            { category: "denied", name: "Denied", listings: [] },
            false,
          )
        ).status,
        401,
      );
      cookies.set("kasitek_admin_session", "fixture-viewer");
      assert.equal((await request("/api/leads")).status, 200);
      assert.equal(
        (
          await post("/api/reports", {
            name: "Forbidden",
            reportKey: "platform-overview",
            days: 7,
          })
        ).status,
        403,
      );
      assert.equal(
        (await request("/api/reports/export?report=platform-overview")).status,
        403,
      );
      assert.equal(
        (
          await fixture.pool.query(
            `SELECT count(*)::int AS count FROM "QuoteRequest"`,
          )
        ).rows[0].count,
        1,
      );
      cookies.set("kasitek_admin_session", "fixture-admin");
      const logout = await post("/api/core/admin/logout", {});
      assert.equal(logout.status, 200);
      assert.equal((await request("/api/leads")).status, 401);
    } finally {
      // Forced cleanup is separate from the asserted cancellation result above.
      for (const stream of streams) stream.destroy();
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
      await fixture.close();
      await new Promise<void>((resolve, reject) =>
        mailSink.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
