import type { FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { canonicalJson, PlatformError, type AdmissionAuthority } from "../../contracts/contracts";
import type { Account, TaskRecord } from "../../contracts/records";
import { projectRecipientText, taskRecipientTextScope } from "../../execution/context/recipient-text";
import { resolveAutomationOwner, resolveAutomationReviewer } from "../../execution/lifecycle/automation-authority";

/**
 * Run access projections shared by the HTTP transports. Composition supplies the stores and
 * evidence checks, so this module holds no wiring and no process state.
 */
export interface RunAccessPorts {
  pool: Pool;
  store: { requireMembership(accountId: string, organizationId: string): Promise<void>;
    getTask(authority: AdmissionAuthority, taskId: string): Promise<TaskRecord> };
  account(request: FastifyRequest): Promise<Account>;
  organizationId(request: FastifyRequest): string;
  parameters(request: FastifyRequest): Record<string, string>;
  evaluationTrials: { authorizeCustomerRoot(db: Pool, accountId: string, organizationId: string, rootTaskId: string): Promise<unknown> };
  evidence?: { taskManifest(taskId: string): Promise<unknown> };
  assertCurrentEvidence(pool: Pool, taskId: string, manifest: unknown, options: { requireActiveTask: boolean }): Promise<void>;
  assertDelegationInputEvidence(pool: Pool, taskId: string): Promise<void>;
  present(record: object): object;
  readTiming(pool: Pool, task: TaskRecord): Promise<object>;
  visibleAnswer(text: string): string;
}

const humanAuthority = (user: Account, organizationId: string, resourceId: string): AdmissionAuthority => ({
  product: "agents", organizationId, resourceId, callerClientId: "agents-execution",
  principal: { kind: "human", issuer: user.issuer, subject: user.subject },
});

export function createRunAccess(options: RunAccessPorts) {
  const { pool } = options;
  const uuid = z.uuid();

  async function humanTask(request: FastifyRequest) {
    const user = await options.account(request), org = options.organizationId(request), taskId = uuid.parse(options.parameters(request).taskId);
    await options.store.requireMembership(user.id, org);
    const task = (await pool.query<TaskRecord>("SELECT * FROM agents_platform.tasks WHERE organization_id=$1 AND id=$2", [org, taskId])).rows[0];
    if (!task) throw new PlatformError("NOT_FOUND", 404, "Task not found");
    const root = task.parent_task_id ? (await pool.query<TaskRecord>("SELECT * FROM agents_platform.tasks WHERE id=$1 AND organization_id=$2", [task.root_task_id, org])).rows[0] : task;
    if (!root || canonicalJson(root.principal) !== canonicalJson(task.principal)) throw new PlatformError("NOT_FOUND", 404, "Task not found");
    let authority = humanAuthority(user, org, root.resource_id);
    let reviewOnly = false;
    if (root.principal.kind === "automation") {
      const owner = await resolveAutomationOwner(pool, org, root.principal), reviewer = await resolveAutomationReviewer(pool, org, root.id);
      if (user.id !== owner && user.id !== reviewer) throw new PlatformError("NOT_FOUND", 404, "Task not found");
      reviewOnly = user.id !== owner;
      if (reviewOnly && task.parent_task_id) throw new PlatformError("NOT_FOUND", 404, "Task not found");
      authority = { product: root.product, organizationId: org, resourceId: root.resource_id, callerClientId: root.caller_client_id, principal: root.principal };
    } else if (root.principal.kind === "visitor" || root.principal.kind === "channel_customer") {
      if (!await options.evaluationTrials.authorizeCustomerRoot(pool, user.id, org, root.id)) throw new PlatformError("NOT_FOUND", 404, "Task not found");
      authority = { product: root.product, organizationId: org, resourceId: root.resource_id, callerClientId: root.caller_client_id, principal: root.principal };
    } else if (root.principal.kind === "application") {
      await options.store.requireMembership(user.id, org);
      const application = (await pool.query("SELECT 1 FROM agents_platform.applications WHERE organization_id=$1 AND id=$2",
        [org, root.principal.applicationId])).rowCount;
      if (!application) throw new PlatformError("NOT_FOUND", 404, "Task not found");
      authority = { product: root.product, organizationId: org, resourceId: root.resource_id, callerClientId: root.caller_client_id, principal: root.principal };
    } else await options.store.getTask(authority, root.id);
    const source = (await pool.query("SELECT deleted_at FROM agents_platform.conversations WHERE id=$1", [task.conversation_id])).rows[0];
    return { task: source?.deleted_at ? { ...task, input: "[Deleted conversation]", output: null } : task, authority, reviewOnly };
  }

  async function readableOutput(taskId: string, output: string | null) {
    const binding = (await pool.query("SELECT channel_binding FROM agents_platform.tasks WHERE id=$1", [taskId])).rows[0]?.channel_binding;
    if (binding) {
      const published = (await pool.query(`SELECT m.body FROM agents_platform.customer_deliveries d
        JOIN agents_platform.customer_messages m ON m.id=d.message_id AND m.task_id=d.task_id
        WHERE d.task_id=$1 AND d.state='published'`, [taskId])).rows[0];
      const projected = output ? projectRecipientText(output, await taskRecipientTextScope(pool, taskId, [output])) : output;
      if (!published || (published.body !== projected && published.body !== output)) return { output: null, outputAvailability: "unavailable" };
    }
    try { await options.assertDelegationInputEvidence(pool, taskId); } catch (error) {
      if (error instanceof PlatformError) return { output: null, outputAvailability: "unavailable" }; throw error;
    }
    if (!output) return { output };
    const visible = async () => options.visibleAnswer(projectRecipientText(output, await taskRecipientTextScope(pool, taskId, [output])));
    const influenced = (await pool.query("SELECT 1 FROM agents_platform.evidence_nodes WHERE task_id=$1 LIMIT 1", [taskId])).rowCount;
    if (!influenced) return { output: await visible() };
    if (!options.evidence) return { output: null, outputAvailability: "unavailable" };
    try {
      await options.assertCurrentEvidence(pool, taskId, await options.evidence.taskManifest(taskId), { requireActiveTask: false });
      return { output: await visible(), outputAvailability: "available" };
    } catch (error) { if (error instanceof PlatformError) return { output: null, outputAvailability: "unavailable" }; throw error; }
  }

  async function readableTask(task: TaskRecord) {
    let input: unknown = task.input, inputAvailability = "available";
    if (task.parent_task_id) try {
      await options.assertDelegationInputEvidence(pool, task.id);
      if (typeof input === "string") input = projectRecipientText(input, await taskRecipientTextScope(pool, task.id, [input]));
    } catch (error) {
      if (!(error instanceof PlatformError)) throw error;
      input = task.input === "[Deleted conversation]" ? task.input : null; inputAvailability = "unavailable";
    }
    const canContinue = task.principal?.kind === "human" && !task.parent_task_id &&
      (task.state === "waiting_authority" || task.state === "waiting_children" &&
        Boolean((await pool.query("SELECT 1 FROM agents_platform.tasks WHERE root_task_id=$1 AND parent_task_id IS NOT NULL AND state='waiting_authority' LIMIT 1", [task.id])).rowCount));
    return { ...options.present(task), ...await options.readTiming(pool, task), canContinue, input, inputAvailability,
      ...await readableOutput(task.id, task.output) };
  }

  return { humanTask, readableTask, readableOutput };
}
