/** Disposable real-provider fixture with local verification email; never uses the owner workspace. */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer, request as httpRequest, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Pool } from "pg";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { buildPlatformApp } from "../src/platform/app";
import { loadPlatformConfig } from "../src/platform/config";
import { PlatformIdentity } from "../src/platform/auth";
import { setupPlatformSchema } from "../src/platform/setup";

async function run() {
  const exec = promisify(execFile);
  const moduleRequire = createRequire(__filename);
  const { chromium } = moduleRequire(process.env.AGENTS_PLAYWRIGHT_MODULE || "playwright");
  const keycloakImage = "quay.io/keycloak/keycloak:26.6.0@sha256:b0e5dbced1775de4d629f103c0a9cfc057decc62ce8d3cb1c54f8849a6c6eb62";
  const postgresImage = "pgvector/pgvector:pg16-bookworm";
  const fixture = await mkdtemp(join(tmpdir(), "agents-identity-"));
  await chmod(fixture, 0o700);
  const suffix = randomBytes(6).toString("hex");
  const providerName = `kasitek-agents-identity-test-${suffix}`;
  const databaseContainer = `kasitek-agents-identity-db-${suffix}`;
  const databaseName = `agents_identity_test_${suffix}`;
  let providerStarted = false, databaseStarted = false;
  let databaseCreated = false;
  let admin: Pool | undefined, pool: Pool | undefined, app: Awaited<ReturnType<typeof buildPlatformApp>> | undefined;
  let browser: any;
  let mailpit: ChildProcess | undefined;
  let frontend: ChildProcess | undefined;
  let proxy: HttpServer | undefined;
  let captureCallback: ((url: string) => void) | undefined;
  let capturedLogoutToken: string | undefined;
  let stage = "fixture startup";
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  async function availablePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return port;
  }
  async function docker(args: string[]): Promise<string> {
    return (await exec("docker", args, { timeout: 240_000, maxBuffer: 1_000_000 })).stdout.trim();
  }
  async function waitFor(check: () => Promise<boolean>, label: string, milliseconds = 120_000): Promise<void> {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      try { if (await check()) return; } catch { /* Startup may not have bound its port yet. */ }
      await sleep(500);
    }
    throw new Error(`${label} timed out`);
  }
  function check(value: unknown, message: string): asserts value { assert.ok(value, message); }
  async function main() {
    let adminUrl = process.env.AGENTS_TEST_DATABASE_URL;
    if (!adminUrl) {
      const password = randomBytes(32).toString("base64url");
      const environment = join(fixture, "postgres.env");
      await writeFile(environment, `POSTGRES_PASSWORD=${password}\n`, { mode: 0o600 });
      databaseStarted = true;
      await docker(["run", "-d", "--name", databaseContainer, "--memory=256m", "--cpus=2", "--env-file", environment,
        "-p", "127.0.0.1::5432", postgresImage]);
      const port = (await docker(["port", databaseContainer, "5432/tcp"])).split(":").at(-1);
      adminUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`;
    }
    admin = new Pool({ connectionString: adminUrl, connectionTimeoutMillis: 2_000 });
    await waitFor(async () => { await admin!.query("SELECT 1"); return true; }, "PostgreSQL startup", 30_000);
    await admin.query(`CREATE DATABASE "${databaseName}"`); databaseCreated = true;
    const dbUrl = new URL(adminUrl); dbUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: dbUrl.href });
    stage = "fresh isolated schema";
    await setupPlatformSchema(pool);
    stage = "isolated mail and provider setup";
    const applicationPort = await availablePort(), providerPort = await availablePort();
    const applicationOrigin = `http://localhost:${applicationPort}`;
    const smtpPort = await availablePort(), mailPort = await availablePort();
    const mailOrigin = `http://127.0.0.1:${mailPort}`;
    const mailpitExecutable = process.env.AGENTS_MAILPIT_EXECUTABLE || join(__dirname, "../../../../infra/identity/.runtime/mailpit/mailpit");
    mailpit = spawn(mailpitExecutable, ["--listen", `127.0.0.1:${mailPort}`, "--smtp", `0.0.0.0:${smtpPort}`, "--database", join(fixture, "mail.db")], { stdio: "ignore" });
    let mailStartupError = false;
    mailpit.once("error", () => { mailStartupError = true; });
    await waitFor(async () => { if (mailStartupError) throw new Error("MailpitUnavailable"); return (await fetch(`${mailOrigin}/api/v1/messages`, { signal: AbortSignal.timeout(1_000) })).ok; }, "Fixture Mailpit startup", 10_000);
    const providerOrigin = `http://localhost:${providerPort}`;
    const clientSecret = randomBytes(32).toString("base64url");
    const password = randomBytes(24).toString("base64url");
    const serviceSecret = randomBytes(32).toString("base64url");
    const template = JSON.parse(await readFile(join(__dirname, "../../../../infra/identity/kasitek-realm.json"), "utf8"));
    const serviceClient = structuredClone(template.clients.find((client: { clientId: string }) => client.clientId === "agents-execution"));
    check(serviceClient, "Execution client template missing");
    serviceClient.secret = serviceSecret;
    const realm = {
      realm: "agents-acceptance", enabled: true, sslRequired: "none", registrationAllowed: true, resetPasswordAllowed: true,
      smtpServer: { host: "host.docker.internal", port: String(smtpPort), from: "accounts@agents.example.test", ssl: "false", starttls: "false", auth: "false" },
      loginWithEmailAllowed: true, verifyEmail: true,
      users: [{ username: "fixture-owner", enabled: true, email: "fixture@example.invalid", emailVerified: true,
        firstName: "Fixture", lastName: "Owner", requiredActions: [], credentials: [{ type: "password", value: password, temporary: false }] },
        { username: "service-account-agents-execution", enabled: true, serviceAccountClientId: "agents-execution",
          clientRoles: { "agents-execution": ["execute"] } }],
      roles: { client: { "agents-execution": structuredClone(template.roles.client["agents-execution"]) } },
      clientScopeMappings: { "agents-execution": [{ client: "agents-execution", roles: ["execute"] }] },
      clients: [{ clientId: "agents", enabled: true, protocol: "openid-connect", publicClient: false, secret: clientSecret,
        standardFlowEnabled: true, directAccessGrantsEnabled: false, serviceAccountsEnabled: false,
        redirectUris: [`${applicationOrigin}/api/auth/callback`], webOrigins: [applicationOrigin],
        attributes: { "pkce.code.challenge.method": "S256", "post.logout.redirect.uris": `${applicationOrigin}/login`,
          "backchannel.logout.url": `http://host.docker.internal:${applicationPort}/api/auth/backchannel-logout`,
          "backchannel.logout.session.required": "true" },
        defaultClientScopes: ["profile", "email", "basic"] }, serviceClient],
    };
    // The container user needs read access to this one fixture file. The parent directory remains private.
    const realmPath = join(fixture, "realm.json"); await writeFile(realmPath, JSON.stringify(realm), { mode: 0o644 });
    providerStarted = true;
    await docker(["run", "-d", "--name", providerName, "--memory=512m", "--cpus=2", "--add-host=host.docker.internal:host-gateway",
      "-e", "JAVA_OPTS_KC_HEAP=-Xms128m -Xmx384m", "-e", `KC_HOSTNAME=${providerOrigin}`, "-e", "KC_HTTP_ENABLED=true",
      "-v", `${realmPath}:/opt/keycloak/data/import/agents-acceptance-realm.json:ro`, "-p", `127.0.0.1:${providerPort}:8080`,
      keycloakImage, "start-dev", "--import-realm"]);
    stage = "provider readiness";
    const issuer = `${providerOrigin}/realms/agents-acceptance`;
    await waitFor(async () => (await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(2_000) })).ok, "Keycloak startup", 150_000);
    stage = "execution service credentials";
    const serviceResponse = await fetch(`${issuer}/protocol/openid-connect/token`, { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({
        grant_type: "client_credentials", client_id: "agents-execution", client_secret: serviceSecret }) });
    check(serviceResponse.ok, "Client credentials token was not issued");
    const serviceTokens = await serviceResponse.json() as { access_token: string };
    const discovery = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json() as { jwks_uri: string };
    const { payload: serviceClaims } = await jwtVerify(serviceTokens.access_token, createRemoteJWKSet(new URL(discovery.jwks_uri)), {
      issuer, audience: "agents-execution", algorithms: ["RS256"] });
    check(serviceClaims.aud === "agents-execution", "Service token audience was not exclusive");
    const resourceAccess = serviceClaims.resource_access as Record<string, { roles: string[] }> | undefined;
    check(JSON.stringify(resourceAccess?.["agents-execution"]?.roles) === JSON.stringify(["execute"]), "Service execution role missing or broader than requested");
    check(!resourceAccess?.["realm-management"] && !serviceClaims.realm_access, "Service token has realm management authority");
    check(!String(serviceClaims.scope ?? "").split(" ").some((scope) => ["profile", "email", "roles", "offline_access"].includes(scope)), "Service token has unrequested scopes");
    const config = loadPlatformConfig({ NODE_ENV: "test", AGENTS_DATABASE_URL: dbUrl.href,
      AGENTS_PUBLIC_URL: applicationOrigin, AGENTS_OIDC_ISSUER_URL: issuer, AGENTS_OIDC_CLIENT_SECRET: clientSecret });
    const identity = new PlatformIdentity(config, pool);
    app = await buildPlatformApp({ config, pool, identity, logging: false });
    app.addHook("preHandler", async (request) => {
      if (request.url === "/api/auth/backchannel-logout") capturedLogoutToken = (request.body as { logout_token?: string })?.logout_token;
    });
    const internalOrigin = await app.listen({ host: "127.0.0.1", port: 0 });
    stage = "owned UI startup";
    const frontendPort = await availablePort(), frontendOrigin = `http://127.0.0.1:${frontendPort}`;
    const frontendEnvironment: NodeJS.ProcessEnv = { ...process.env, AGENTS_API_PROXY_TARGET: internalOrigin };
    delete frontendEnvironment.OPENROUTER_API_KEY;
    frontend = spawn(process.execPath, [join(__dirname, "../../web/node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(frontendPort), "--strictPort"], {
      cwd: join(__dirname, "../../web"), stdio: "ignore", env: frontendEnvironment,
    });
    let frontendUnavailable = false;
    frontend.once("error", () => { frontendUnavailable = true; });
    await waitFor(async () => !frontendUnavailable && (await fetch(frontendOrigin, { signal: AbortSignal.timeout(1_000) })).ok, "Owned identity UI", 30_000);
    proxy = createHttpServer((request, reply) => {
      if (captureCallback && request.url?.startsWith("/api/auth/callback?")) {
        const capture = captureCallback; captureCallback = undefined;
        capture(new URL(request.url, applicationOrigin).href);
        reply.writeHead(200, { "content-type": "application/json" }); reply.end('{"captured":true}'); return;
      }
      const upstreamOrigin = request.url?.startsWith("/api/") ? internalOrigin : frontendOrigin;
      const upstream = httpRequest(new URL(request.url ?? "/", upstreamOrigin), { method: request.method, headers: request.headers }, (response) => {
        reply.writeHead(response.statusCode ?? 502, response.headers); response.pipe(reply);
      });
      upstream.on("error", () => { if (!reply.headersSent) reply.writeHead(502); reply.end(); });
      request.pipe(upstream);
    });
    await new Promise<void>((resolve, reject) => { proxy!.once("error", reject); proxy!.listen(applicationPort, "0.0.0.0", resolve); });
    stage = "browser startup";
    browser = await chromium.launch({ executablePath: process.env.AGENTS_BROWSER_EXECUTABLE || "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
    async function login(page: any) {
      await page.goto(`${applicationOrigin}/api/auth/login`);
      if (!page.url().startsWith(`${applicationOrigin}/app`)) {
        await page.locator("#username").fill("fixture-owner"); await page.locator("#password").fill(password);
        await Promise.all([page.waitForURL((url: URL) => url.origin === applicationOrigin), page.locator("#kc-login").click()]);
      }
      check(page.url().startsWith(`${applicationOrigin}/app`), "OIDC callback did not complete");
    }
    async function cookieValue(context: any): Promise<string> {
      const cookies = await context.cookies(applicationOrigin);
      const cookie = cookies.find((value: { name: string }) => value.name === "agents_session");
      check(cookie?.httpOnly && cookie?.sameSite === "Lax", "Product cookie flags were not enforced");
      return cookie.value;
    }
    async function sessionStatus(token: string) {
      return (await fetch(`${applicationOrigin}/api/session`, { headers: { cookie: `agents_session=${token}` } })).status;
    }
    async function negativeLogin(mode: "state" | "nonce" | "pkce") {
      const context = await browser.newContext(), page = await context.newPage();
      context.setDefaultTimeout(15_000);
      try {
        let timeout: ReturnType<typeof setTimeout>;
        const captured = new Promise<string>((resolve, reject) => {
          timeout = setTimeout(() => { captureCallback = undefined; reject(new Error("CallbackCaptureTimeout")); }, 25_000);
          captureCallback = (url) => { clearTimeout(timeout); resolve(url); };
        });
        await page.goto(`${applicationOrigin}/api/auth/login`);
        await page.locator("#username").fill("fixture-owner"); await page.locator("#password").fill(password);
        await Promise.all([page.waitForURL(`${applicationOrigin}/api/auth/callback?**`), page.locator("#kc-login").click()]);
        const callbackUrl = new URL(await captured);
        if (mode === "state") callbackUrl.searchParams.set("state", "incorrect-state");
        else {
          const cookie = (await context.cookies(applicationOrigin)).find((value: { name: string }) => value.name === "agents_login");
          check(cookie, "Login transaction cookie missing");
          const digest = createHash("sha256").update(cookie.value).digest("hex");
          if (mode === "nonce") await pool!.query("UPDATE agents_platform.login_transactions SET nonce='incorrect-nonce' WHERE token_hash=$1", [digest]);
          else await pool!.query("UPDATE agents_platform.login_transactions SET verifier='incorrect-verifier' WHERE token_hash=$1", [digest]);
        }
        const response = await context.request.get(callbackUrl.href, { maxRedirects: 0 });
        check(response.status() === 302 && response.headers().location === "/login?error=failed", `${mode} mismatch was not rejected, status ${response.status()}`);
        check(!(await context.cookies(applicationOrigin)).some((cookie: { name: string }) => cookie.name === "agents_session"), `${mode} mismatch created a session`);
      } finally { captureCallback = undefined; await context.close(); }
    }
    stage = "valid provider login";
    const context = await browser.newContext(), page = await context.newPage();
    await login(page); const firstCookie = await cookieValue(context);
    check(await sessionStatus(firstCookie) === 200, "Real OIDC session was not accepted");
    const org = await page.evaluate(async () => {
      const response = await fetch("/api/organizations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Identity acceptance" }) });
      return { status: response.status, body: await response.json() };
    });
    check(org.status === 201 && org.body.organization.id, "Authenticated organization creation failed");
    // A second product session shares the provider session. Backchannel logout must revoke both.
    await login(page); const secondCookie = await cookieValue(context);
    check(secondCookie !== firstCookie, "Second OIDC login did not create another product session");
    for (const logoutToken of ["malformed.jwt", `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ iss: issuer, aud: "agents", sid: "forged", iat: Math.floor(Date.now() / 1000) })).toString("base64url")}.`]) {
      const invalid = await fetch(`${applicationOrigin}/api/auth/backchannel-logout`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ logout_token: logoutToken }) });
      check(invalid.status === 400, "Malformed or unsigned logout token was accepted");
    }
    check(await sessionStatus(firstCookie) === 200, "Invalid logout revoked a session");
    const logout = await page.evaluate(async () => {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      return { status: response.status, body: await response.json() };
    });
    check(logout.status === 200, "Local logout failed");
    check(await sessionStatus(secondCookie) === 401 && await sessionStatus(firstCookie) === 200, "Local logout did not target only its cookie");
    stage = "provider logout";
    await page.goto(logout.body.redirectTo);
    if (page.url().startsWith(providerOrigin)) {
      const confirm = page.locator("#kc-logout");
      if (await confirm.count()) await confirm.click();
    }
    await waitFor(async () => await sessionStatus(firstCookie) === 401, "Signed backchannel logout", 20_000);
    check(capturedLogoutToken, "Provider did not send a logout token");
    const realToken = capturedLogoutToken;
    const replay = await fetch(`${applicationOrigin}/api/auth/backchannel-logout`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ logout_token: realToken }) });
    check(replay.status === 204, "Signed logout replay was not idempotent");
    check(Number((await pool.query("SELECT count(*) FROM agents_platform.logout_tokens")).rows[0].count) === 1, "Signed logout replay was persisted twice");
    const parts = realToken.split("."); parts[2] = (parts[2]!.startsWith("A") ? "B" : "A") + parts[2]!.slice(1);
    const badSignature = await fetch(`${applicationOrigin}/api/auth/backchannel-logout`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ logout_token: parts.join(".") }) });
    check(badSignature.status === 400, "Invalid logout signature was accepted");
    await context.close();
    for (const mode of ["state", "nonce", "pkce"] as const) { stage = mode + " mismatch"; await negativeLogin(mode); }
    check(Number((await pool.query("SELECT count(*) FROM agents_platform.sessions WHERE revoked_at IS NULL")).rows[0].count) === 0, "Rejected callbacks created a session");
    stage = "fresh registration and verification email";
    const signupContext = await browser.newContext(), signupPage = await signupContext.newPage();
    signupContext.setDefaultTimeout(20_000);
    const signupEmail = `signup-${suffix}@agents.example.test`;
    const evidenceDirectory = join(__dirname, "../../web/.artifacts/identity-ui");
    await mkdir(evidenceDirectory, { recursive: true });
    stage = "public landing Get started";
    await signupPage.goto(applicationOrigin);
    await signupPage.getByRole("link", { name: "Get started", exact: true }).click();
    stage = "public signup account link";
    await signupPage.waitForURL(`${applicationOrigin}/signup`);
    await signupPage.getByRole("link", { name: "Create account", exact: true }).click();
    stage = "provider registration form";
    await signupPage.locator("#email").waitFor({ state: "visible" });
    check(new URL(signupPage.url()).searchParams.get("prompt") === "create", "Registration did not use provider signup intent");
    for (const [selector, value] of [["#username", `signup-${suffix}`], ["#email", signupEmail], ["#firstName", "Signup"], ["#lastName", "Fixture"], ["#password", password], ["#password-confirm", password]]) {
      const field = signupPage.locator(selector);
      if (await field.count()) await field.fill(value);
    }
    stage = "provider registration submission";
    await signupPage.locator('input[type="submit"], button[type="submit"]').first().click();
    await signupPage.waitForURL((url: URL) => url.origin === providerOrigin && url.pathname.includes("login-actions"));
    check(!(await signupContext.cookies(applicationOrigin)).some((value: { name: string }) => value.name === "agents_session"), "Unverified registration created a product session");
    stage = "local verification email";
    let messageId: string | undefined;
    await waitFor(async () => {
      const result = await (await fetch(`${mailOrigin}/api/v1/messages`)).json() as { messages: { ID: string; To: { Address: string }[] }[] };
      messageId = result.messages.find(item => item.To.some(recipient => recipient.Address === signupEmail))?.ID;
      return Boolean(messageId);
    }, "Signup verification email", 30_000);
    const mail = await (await fetch(`${mailOrigin}/api/v1/message/${messageId}`)).json() as { Text: string; HTML: string };
    const verification = (mail.Text || mail.HTML).match(/https?:[^\s<>"']+action-token[^\s<>"']*/u)?.[0]?.replaceAll("&amp;", "&");
    check(verification && new URL(verification).origin === providerOrigin, "Provider verification link missing");
    stage = "verification callback and first workspace entry";
    await signupPage.goto(verification);
    const confirmVerification = signupPage.locator('a:has-text("Proceed")');
    if (await confirmVerification.count()) await confirmVerification.click();
    if (await signupPage.locator("#password-new").count()) {
      await signupPage.locator("#password-new").fill(password);
      await signupPage.locator("#password-confirm").fill(password);
      await signupPage.locator('input[type="submit"], button[type="submit"]').first().click();
    }
    await signupPage.waitForURL((url: URL) => url.origin === applicationOrigin && ["/app", "/app/agents"].includes(url.pathname));
    const signupCookie = await cookieValue(signupContext);
    check(await sessionStatus(signupCookie) === 200, "Verified registration did not create a product session");
    const freshSession = await signupPage.evaluate(async () => (await fetch("/api/session")).json());
    check(freshSession.organizations.length === 0 && freshSession.account.email === signupEmail, "New account inherited a workspace or wrong identity");
    stage = "first workspace through application controls";
    await signupPage.getByRole("button", { name: "Create workspace", exact: true }).click();
    await signupPage.getByRole("textbox", { name: "Workspace name", exact: true }).fill("Signup acceptance");
    await signupPage.getByRole("dialog").getByRole("button", { name: "Create workspace", exact: true }).click();
    await signupPage.getByRole("combobox", { name: "Workspace", exact: true }).waitFor({ state: "visible" });
    check(await signupPage.getByRole("combobox", { name: "Workspace", exact: true }).locator("option:checked").textContent() === "Signup acceptance", "First workspace UI did not select the created workspace");
    const createdSession = await signupPage.evaluate(async () => (await fetch("/api/session")).json());
    check(createdSession.organizations.length === 1 && createdSession.organizations[0].name === "Signup acceptance", "First workspace UI did not persist the expected membership");
    for (const width of [1440, 768, 390]) {
      await signupPage.setViewportSize({ width, height: 1000 });
      check(await signupPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Signup workspace overflow at ${width}px`);
      await signupPage.screenshot({ path: join(evidenceDirectory, `verified-workspace-${width}.png`), fullPage: true });
    }
    await signupPage.setViewportSize({ width: 1440, height: 1000 });
    stage = "application sign-out";
    await signupPage.getByRole("button", { name: "Sign out", exact: true }).click();
    await signupPage.waitForURL((url: URL) => url.origin === providerOrigin || url.origin === applicationOrigin && url.pathname === "/login");
    const signupConfirmLogout = signupPage.locator("#kc-logout");
    await waitFor(async () => new URL(signupPage.url()).origin === applicationOrigin && new URL(signupPage.url()).pathname === "/login" || await signupConfirmLogout.isVisible(), "Provider sign-out screen", 20_000);
    if (await signupConfirmLogout.isVisible()) await signupConfirmLogout.click();
    await signupPage.waitForURL(`${applicationOrigin}/login`);
    check(await sessionStatus(signupCookie) === 401, "Signup account sign-out failed");
    stage = "registered account return login";
    const returnDestination = "/app/settings?from=login";
    await signupPage.goto(`${applicationOrigin}${returnDestination}`);
    await signupPage.waitForURL((url: URL) => url.origin === applicationOrigin && url.pathname === "/login");
    check(new URL(signupPage.url()).searchParams.get("returnTo") === returnDestination, "Application guard lost the intended destination");
    await signupPage.getByRole("link", { name: "Sign in", exact: true }).click();
    await signupPage.locator("#username").fill(`signup-${suffix}`);
    await signupPage.locator("#password").fill(password);
    await Promise.all([signupPage.waitForURL(`${applicationOrigin}${returnDestination}`), signupPage.locator("#kc-login").click()]);
    check(await sessionStatus(await cookieValue(signupContext)) === 200, "Registered account return login failed");
    await signupPage.getByRole("heading", { name: "Settings", exact: true }).waitFor({ state: "visible" });
    check(await signupPage.getByRole("combobox", { name: "Workspace", exact: true }).locator("option:checked").textContent() === "Signup acceptance", "Return login lost the existing workspace");
    await signupPage.screenshot({ path: join(evidenceDirectory, "return-login-settings.png"), fullPage: true });
    await writeFile(join(evidenceDirectory, "identity-ui-proof.json"), JSON.stringify({ status: "passed", realLanding: true, actualSignupControls: true, providerRegistration: true, localEmailVerification: true, actualWorkspaceDialog: true, actualSignOut: true, guardedSettingsReturn: true, workspaceRetained: true, widths: [1440, 768, 390], modelCalls: 0 }, null, 2), { mode: 0o600 });
    await signupContext.close();
    console.log(JSON.stringify({ provider: keycloakImage, checks: { browserAuthorizationCodePkce: true, realLandingSignupWorkspaceControls: true, applicationGuardReturnLogin: true, freshSignup: true, localVerificationEmail: true, firstWorkspaceAfterSignup: true, safeReturnDestination: true, registeredReturnLogin: true, stateRejection: true,
      serviceClientCredentialsAudienceAndRole: true, noRealmManagementAuthority: true, nonceRejection: true, pkceVerifierRejection: true, opaqueSession: true, organizationCreation: true, localLogout: true,
      providerSignedBackchannel: true, logoutReplay: true, malformedAndUnsignedAndBadSignatureRejection: true },
      unverified: ["production deployment"] }));
  }
  let cleanupPromise: Promise<void> | undefined;
  function cleanup(): Promise<void> {
    cleanupPromise ??= (async () => {
    await browser?.close().catch(() => {});
    if (frontend && frontend.exitCode === null && frontend.signalCode === null) { frontend.kill("SIGTERM"); await new Promise<void>(resolve => frontend!.once("exit", () => resolve())); }
    if (mailpit && mailpit.exitCode === null) { mailpit.kill("SIGTERM"); await new Promise<void>(resolve => { mailpit!.once("exit", () => resolve()); setTimeout(resolve, 5_000); }); }
    if (proxy) { proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy!.close(() => resolve())); }
    await app?.close().catch(() => {}); await pool?.end().catch(() => {});
    if (databaseCreated && admin) await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => {});
    await admin?.end().catch(() => {});
    if (providerStarted) await docker(["rm", "-f", providerName]).catch(() => {});
    if (databaseStarted) await docker(["rm", "-f", databaseContainer]).catch(() => {});
    await rm(fixture, { recursive: true, force: true });
    })();
    return cleanupPromise;
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
    void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
  let exitCode = 0;
  try { await main(); }
  catch (error) {
    const failedPage = browser?.contexts().at(-1)?.pages().at(-1);
    if (failedPage) {
      const evidence = join(__dirname, "../../web/.artifacts/identity-ui");
      await mkdir(evidence, { recursive: true });
      await failedPage.screenshot({ path: join(evidence, "identity-ui-failure.png"), fullPage: true }).catch(() => {});
    }
    // Provider responses, commands and URLs can contain fixture credentials. Emit only a bounded diagnostic.
    console.error(`Identity fixture failed at ${stage}: ${error instanceof assert.AssertionError ? error.message : error instanceof Error ? error.name : "UnknownError"}`);
    exitCode = 1;
  } finally { await cleanup(); }
  process.exitCode = exitCode;

}
void run().catch(() => { console.error("Identity fixture could not start"); process.exitCode = 1; });
