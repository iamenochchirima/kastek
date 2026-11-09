#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  InteractiveSandboxClient,
  InteractiveClientError,
  type InteractiveTranscript,
  type InteractiveTurnResult,
  type InteractiveView,
  type ProductApiConfig,
  type SavedOutcomeRecord,
} from "./harness/interactive.js";
import { setupSandbox } from "./harness/setup.js";
import type {
  AgentRef,
  InteractiveSession,
  InteractiveSessionDetail,
  OutcomeRef,
  SandboxDetail,
} from "./store.js";

type Options = {
  command: string;
  subcommand?: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
};

type Json = Record<string, any>;

const usage = `Interactive sandbox client

Usage:
  client view [--sandbox <id>] [--json]
  client sandbox list [--limit <n>] [--json]
  client sandbox show [--sandbox <id>] [--json]
  client setup --sandbox <id> --file <setup.json> [--json]
  client chat --sandbox <id> --agent-ref <ref> --message <text> [--json]
  client chat --sandbox <id> --session <id> --message <text> [--json]
  client sessions list [--sandbox <id>] [--json]
  client sessions show --sandbox <id> <sessionId> [--json]
  client transcript --sandbox <id> <sessionId> [--json]
  client outcomes [--sandbox <id>] [--json]
  client records [--sandbox <id>] [--outcome <id>] [--json]

Environment:
  EVALS_API_URL              Evaluation control plane URL (default http://127.0.0.1:4600)
  EVALS_OPERATOR_TOKEN       Evaluation control plane operator token (required)
  EVALS_SANDBOX_ID           Default sandbox id
  AGENTS_BASE_URL            Agents product origin (required for setup, chat, transcript, records)
  AGENTS_ORIGIN              Agents request Origin (default derived from AGENTS_BASE_URL)
  AGENTS_ORGANIZATION_ID     Agents organization id (required for setup, chat, transcript, records)
  AGENTS_OWNER_SESSION       Normal owner session token (required for setup, chat, transcript, records)
  AGENTS_SESSION_COOKIE_NAME Session cookie name (default agents_session)
  AGENTS_MODEL_API_KEY       Model provider key used by setup when the file omits model.apiKey
  AGENTS_MEMBER_SESSION      Optional second member session used by setup

The client never prints session cookies, model keys or operator tokens.`;

function parseOptions(argv: string[]): Options {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith("--")) {
      positional.push(item);
      continue;
    }
    const key = item.slice(2);
    if (!key) continue;
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  const [command = "help", maybeSubcommand, ...rest] = positional;
  const hasSubcommand = ["sandbox", "sessions"].includes(command);
  return {
    command,
    subcommand: hasSubcommand ? maybeSubcommand : undefined,
    positionals: hasSubcommand ? rest : positional.slice(1),
    flags,
  };
}

function flag(options: Options, name: string): string | undefined {
  const value = options.flags[name];
  return typeof value === "string" ? value : undefined;
}

function hasFlag(options: Options, name: string): boolean {
  return options.flags[name] === true;
}

function jsonOutput(options: Options): boolean {
  return hasFlag(options, "json");
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function productConfig(): ProductApiConfig {
  const baseUrl = required(env("AGENTS_BASE_URL"), "AGENTS_BASE_URL");
  return {
    baseUrl,
    origin: env("AGENTS_ORIGIN") ?? new URL(baseUrl).origin,
    organizationId: required(env("AGENTS_ORGANIZATION_ID"), "AGENTS_ORGANIZATION_ID"),
    session: required(env("AGENTS_OWNER_SESSION"), "AGENTS_OWNER_SESSION"),
    sessionCookieName: env("AGENTS_SESSION_COOKIE_NAME"),
  };
}

function controlConfig(options: Options) {
  return {
    apiUrl: env("EVALS_API_URL") ?? "http://127.0.0.1:4600",
    operatorToken: required(env("EVALS_OPERATOR_TOKEN"), "EVALS_OPERATOR_TOKEN"),
    sandboxId: required(flag(options, "sandbox") ?? env("EVALS_SANDBOX_ID"), "sandbox id"),
  };
}

function client(options: Options, needsProduct = true): InteractiveSandboxClient {
  return new InteractiveSandboxClient({
    controlPlane: controlConfig(options),
    product: needsProduct
      ? productConfig()
      : {
          baseUrl: "http://127.0.0.1:1",
          origin: "http://127.0.0.1:1",
          organizationId: "unused",
          session: "unused",
        },
  });
}

function output(task: Json | undefined): string {
  return typeof task?.output === "string" ? task.output : "";
}

function taskState(task: Json | undefined): string {
  return typeof task?.state === "string" ? task.state : "unknown";
}

function truncate(value: string, length = 180): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

function comparisonDate(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) || 0 : 0;
}

function versionLabel(version: Record<string, any> | null | undefined): string {
  if (!version) return "none";
  return `${String(version.id)} (${String(version.codeRevision)})`;
}

function printSandbox(detail: SandboxDetail): void {
  console.log(`Sandbox:    ${detail.sandbox.id}`);
  console.log(`Product:    ${detail.sandbox.product}`);
  console.log(`Status:     ${detail.sandbox.status}`);
  console.log(`Version:    ${versionLabel(detail.version)}`);
  console.log(`Updated:    ${detail.sandbox.updatedAt}`);
  console.log("Workspaces:");
  if (!detail.workspaceRefs.length) {
    console.log("  (none)");
    return;
  }
  for (const workspace of detail.workspaceRefs) {
    console.log(
      `  ${workspace.id}  product=${workspace.productWorkspaceId}  ${workspace.label ?? ""}`.trimEnd(),
    );
  }
}

function printAgents(agents: AgentRef[]): void {
  console.log("Agents:");
  if (!agents.length) {
    console.log("  (none)");
    return;
  }
  for (const agent of agents) {
    console.log(
      `  ${agent.id}  agent=${agent.productAgentId}  version=${agent.productVersionId}  workspace=${agent.workspaceRefId}`,
    );
  }
}

function printSessions(sessions: InteractiveSession[]): void {
  console.log("Sessions:");
  if (!sessions.length) {
    console.log("  (none)");
    return;
  }
  for (const session of sessions) {
    console.log(
      `  ${session.id}  ${session.state}  turns=${session.turnCount}  conversation=${session.productConversationId}  latest=${session.latestTaskId}  ${session.lastActivityAt}`,
    );
  }
}

function printOutcomes(outcomes: OutcomeRef[]): void {
  console.log("Saved outcomes:");
  if (!outcomes.length) {
    console.log("  (none)");
    return;
  }
  for (const outcome of outcomes) {
    console.log(
      `  ${outcome.id}  ${outcome.kind}/${outcome.status}  outcome=${outcome.productOutcomeId}  record=${outcome.productRecordId ?? "none"}  task=${outcome.taskId ?? "none"}`,
    );
  }
}

function printView(view: InteractiveView): void {
  printSandbox(view.sandbox);
  console.log("");
  printAgents(view.agents);
  console.log("");
  printSessions(view.sessions);
  console.log("");
  printOutcomes(view.outcomes);
}

function printTurn(result: InteractiveTurnResult): void {
  const task = result.task.task;
  console.log(`Session:      ${result.session.id}`);
  console.log(`Turn:         ${result.turn.sequence}`);
  console.log(`Session state:${result.session.state}`);
  console.log(`Conversation: ${result.session.productConversationId}`);
  console.log(`Task:         ${String(task.id)} (${taskState(task)})`);
  if (task.errorCode) console.log(`Error:        ${String(task.errorCode)}`);
  console.log("");
  console.log(output(task) || "(no output)");
  console.log("");
  const passages = result.evidence?.passages ?? [];
  console.log(`Evidence:     ${passages.length} passage(s)`);
  for (const passage of passages) {
    console.log(`  ${passage.label ?? passage.id ?? "passage"}  ${passage.title ?? ""}`);
  }
}

function printOperation(operation: Json): void {
  const label = [operation.kind, operation.name].filter(Boolean).join("/") || "operation";
  const state = operation.state ?? "unknown";
  const duration = typeof operation.durationMs === "number" ? ` ${operation.durationMs}ms` : "";
  const error = operation.errorCode ? ` error=${operation.errorCode}` : "";
  console.log(`  - ${label}  ${state}${duration}${error}`);
}

function printEvent(event: Json): void {
  const payload = event.payload && typeof event.payload === "object" ? event.payload as Json : {};
  const detail = payload.name ?? payload.operationId ?? payload.enquiryId ?? "";
  console.log(`  - ${String(event.kind)}${detail ? `  ${detail}` : ""}`);
}

function printTranscript(transcript: InteractiveTranscript): void {
  const { session } = transcript;
  console.log(`Session:      ${session.id}`);
  console.log(`State:        ${session.state}`);
  console.log(`Conversation: ${session.productConversationId}`);
  console.log(`Turns:        ${session.turnCount}`);
  console.log(`Conversation tasks: ${transcript.conversationTasks.length}`);
  console.log("");
  for (const turn of transcript.turns) {
    const task = turn.task;
    console.log(`Turn ${turn.sequence}  ${taskState(task.task)}  task=${turn.productTaskId}`);
    console.log(`User:      ${String(task.task.input ?? "")}`);
    console.log(`Assistant: ${output(task.task) || "(no output)"}`);
    const operations = Array.isArray(task.operations)
      ? [...task.operations].sort((left, right) => comparisonDate(left.startedAt) - comparisonDate(right.startedAt))
      : [];
    if (operations.length) {
      console.log("Operations:");
      for (const operation of operations) printOperation(operation);
    }
    const events = Array.isArray(task.events)
      ? [...task.events].sort((left, right) => Number(left.sequence ?? 0) - Number(right.sequence ?? 0))
      : [];
    if (events.length) {
      console.log("Events:");
      for (const event of events) printEvent(event);
    }
    const passages = turn.evidence?.passages ?? [];
    if (passages.length) {
      console.log("Evidence:");
      for (const passage of passages) {
        console.log(
          `  - ${passage.label ?? passage.id ?? "passage"}  ${passage.title ?? ""}${passage.text ? `  ${truncate(String(passage.text), 240)}` : ""}`,
        );
      }
    }
    console.log("");
  }
}

function printRecord(record: SavedOutcomeRecord): void {
  const { outcomeRef } = record;
  console.log(`Outcome:   ${outcomeRef.id}  ${outcomeRef.kind}/${outcomeRef.status}`);
  console.log(`Product:   ${outcomeRef.productOutcomeId}`);
  console.log(`Record:    ${outcomeRef.productRecordId ?? "none"}`);
  console.log(`Task:      ${outcomeRef.taskId ?? "none"}`);
  console.log(`Digests:   request=${outcomeRef.requestDigest.slice(0, 12)}… response=${outcomeRef.responseDigest.slice(0, 12)}…`);
  if (record.enquiry) {
    const enquiry = record.enquiry;
    console.log(`Enquiry:   ${enquiry.state ?? "unknown"}  ${enquiry.id ?? outcomeRef.productOutcomeId}`);
    if (enquiry.fields && typeof enquiry.fields === "object") {
      console.log(`Fields:    ${JSON.stringify(enquiry.fields)}`);
    }
  }
  if (record.record) {
    const customer = record.record;
    console.log(`Customer:  ${customer.id ?? "unknown"}  source=${customer.sourceEnquiryId ?? "unknown"}`);
    if (customer.fields && typeof customer.fields === "object") {
      console.log(`Contact:   ${JSON.stringify(customer.fields)}`);
    }
  }
}

async function readSetupFile(path: string): Promise<Json> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Setup file must contain a JSON object");
  }
  return value as Json;
}

async function setup(options: Options): Promise<void> {
  const file = required(flag(options, "file"), "--file");
  const input = await readSetupFile(file);
  const model = input.model as Json | undefined;
  const knowledge = input.knowledge as Json | undefined;
  const agent = input.agent as Json | undefined;
  if (!model || !knowledge || !agent) {
    throw new Error("Setup file requires model, knowledge and agent objects");
  }
  const apiKey = String(model.apiKey ?? env("AGENTS_MODEL_API_KEY") ?? "");
  if (!apiKey) {
    throw new Error("model.apiKey or AGENTS_MODEL_API_KEY is required");
  }
  const configuredClient = client(options, true);
  const workspace = await configuredClient.ensureWorkspaceRef(
    productConfig().organizationId,
    typeof input.workspaceLabel === "string" ? input.workspaceLabel : "Interactive workspace",
  );
  const memberInput = input.member as Json | undefined;
  const memberSession = String(memberInput?.session ?? env("AGENTS_MEMBER_SESSION") ?? "");
  const result = await setupSandbox({
    baseUrl: productConfig().baseUrl,
    origin: productConfig().origin,
    organizationId: productConfig().organizationId,
    ownerSession: productConfig().session,
    model: {
      providerId: String(model.providerId),
      name: String(model.name),
      apiKey,
      modelId: String(model.modelId),
    },
    knowledge: {
      title: String(knowledge.title),
      content: String(knowledge.content),
      visibility: knowledge.visibility === "public" ? "public" : "private",
    },
    agent: {
      name: String(agent.name),
      configuration: (agent.configuration ?? {}) as Record<string, unknown>,
      instructions: String(agent.instructions ?? ""),
      ...(agent.rootTokenLimit ? { rootTokenLimit: Number(agent.rootTokenLimit) } : {}),
      ...(Array.isArray(agent.responsibilities)
        ? { responsibilities: agent.responsibilities as Array<"answer-questions" | "customer-support" | "bookings" | "enquiries"> }
        : {}),
    },
    ...(input.website && typeof input.website === "object"
      ? { website: { allowedOrigins: ((input.website as Json).allowedOrigins ?? []) as string[] } }
      : {}),
    ...(memberInput && memberInput.email && memberSession
      ? { member: { email: String(memberInput.email), session: memberSession } }
      : {}),
    controlPlane: {
      apiUrl: controlConfig(options).apiUrl,
      operatorToken: controlConfig(options).operatorToken,
      sandboxId: controlConfig(options).sandboxId,
      workspaceRefId: workspace.id,
    },
  });
  if (jsonOutput(options)) {
    console.log(JSON.stringify({ workspaceRefId: workspace.id, ...result }, null, 2));
    return;
  }
  console.log(`Workspace reference: ${workspace.id}`);
  console.log(`Agent:               ${result.agentId}`);
  console.log(`Version:             ${result.versionId}`);
  console.log(`Knowledge source:    ${result.sourceId}`);
  console.log(`Agent reference:     ${result.agentRefId ?? "none"}`);
  console.log(`Deployment:          ${result.deploymentId ?? "none"}`);
  console.log("Steps:");
  for (const step of result.steps) console.log(`  - ${step}`);
}

async function chat(options: Options): Promise<void> {
  const message = required(flag(options, "message"), "--message");
  const configuredClient = client(options, true);
  const sessionId = flag(options, "session");
  const result = sessionId
    ? await configuredClient.continueSession({ sessionId, message })
    : await configuredClient.startSession({
        agentRefId: required(flag(options, "agent-ref"), "--agent-ref"),
        message,
      });
  if (jsonOutput(options)) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printTurn(result);
}

async function transcript(options: Options): Promise<void> {
  const sessionId = required(options.positionals[0] ?? flag(options, "session"), "session id");
  const value = await client(options, true).transcript(sessionId);
  if (jsonOutput(options)) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  printTranscript(value);
}

async function sessions(options: Options): Promise<void> {
  const configuredClient = client(options, false);
  if (options.subcommand === "show") {
    const sessionId = required(options.positionals[0], "session id");
    const detail = await configuredClient.session(sessionId);
    if (jsonOutput(options)) {
      console.log(JSON.stringify(detail, null, 2));
      return;
    }
    printSessionDetail(detail);
    return;
  }
  const list = await configuredClient.listSessions(Number(flag(options, "limit") ?? 50));
  if (jsonOutput(options)) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  printSessions(list);
}

function printSessionDetail(detail: InteractiveSessionDetail): void {
  printSessions([detail.session]);
  console.log("Turns:");
  if (!detail.turns.length) {
    console.log("  (none)");
    return;
  }
  for (const turn of detail.turns) {
    console.log(
      `  ${turn.sequence}  task=${turn.productTaskId}  ${turn.state}  input=${turn.inputDigest.slice(0, 12)}… output=${turn.outputDigest?.slice(0, 12) ?? "none"}…`,
    );
  }
}

async function outcomes(options: Options): Promise<void> {
  const value = await client(options, false).listOutcomes();
  if (jsonOutput(options)) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  printOutcomes(value);
}

async function records(options: Options): Promise<void> {
  const configuredClient = client(options, true);
  const outcomeId = flag(options, "outcome");
  if (outcomeId) {
    const value = await configuredClient.savedOutcomeRecord(outcomeId);
    if (jsonOutput(options)) {
      console.log(JSON.stringify(value, null, 2));
      return;
    }
    printRecord(value);
    return;
  }
  const available = await configuredClient.listOutcomes();
  if (!available.length) {
    console.log("No saved outcomes");
    return;
  }
  const results: SavedOutcomeRecord[] = [];
  for (const outcome of available.slice(0, 10)) {
    results.push(await configuredClient.savedOutcomeRecord(outcome.id));
  }
  if (jsonOutput(options)) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  for (const [index, record] of results.entries()) {
    if (index > 0) console.log("");
    printRecord(record);
  }
}

async function view(options: Options): Promise<void> {
  const value = await client(options, false).view();
  if (jsonOutput(options)) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  printView(value);
}

async function sandbox(options: Options): Promise<void> {
  const configuredClient = client(options, false);
  if (options.subcommand === "list") {
    const value = await configuredClient.listSandboxes(Number(flag(options, "limit") ?? 50));
    if (jsonOutput(options)) {
      console.log(JSON.stringify(value, null, 2));
      return;
    }
    if (!value.length) {
      console.log("No sandboxes");
      return;
    }
    for (const [index, detail] of value.entries()) {
      if (index > 0) console.log("");
      printSandbox(detail);
    }
    return;
  }
  const value = await configuredClient.sandbox();
  if (jsonOutput(options)) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  printSandbox(value);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (hasFlag(options, "help") || options.command === "help") {
    console.log(usage);
    return;
  }
  switch (options.command) {
    case "view":
      return view(options);
    case "sandbox":
      return sandbox(options);
    case "setup":
      return setup(options);
    case "chat":
      return chat(options);
    case "sessions":
      return sessions(options);
    case "transcript":
      return transcript(options);
    case "outcomes":
      return outcomes(options);
    case "records":
      return records(options);
    default:
      console.error(`Unknown command: ${options.command}\n`);
      console.error(usage);
      process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  if (error instanceof InteractiveClientError) {
    console.error(error.message);
  } else if (process.env.EVALS_DEBUG === "1" && error instanceof Error) {
    console.error(error.stack);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
