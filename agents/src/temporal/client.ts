import { Client, Connection } from "@temporalio/client";
import type { AppConfig } from "../config";
import type { DurableRunInput } from "./contracts";
import type { ApprovalSignal, CancellationSignal } from "./contracts";
import { agentRunWorkflow } from "./workflows";

export async function connectTemporal(config: AppConfig): Promise<{ connection: Connection; client: Client }> {
  const connection = await Connection.connect({
    address: config.TEMPORAL_ADDRESS,
    apiKey: config.TEMPORAL_API_KEY || undefined,
    tls: config.TEMPORAL_MODE === "cloud" ? {} : undefined,
  });
  return { connection, client: new Client({ connection, namespace: config.TEMPORAL_NAMESPACE }) };
}

export async function startDurableRun(
  client: Client,
  config: AppConfig,
  input: DurableRunInput,
): Promise<void> {
  await client.workflow.start(agentRunWorkflow, {
    workflowId: `agent-run-${input.runId}`,
    taskQueue: config.TEMPORAL_TASK_QUEUE,
    args: [input],
  });
}

export async function signalRunApproval(client: Client, runId: string, signal: ApprovalSignal): Promise<void> {
  await client.workflow.getHandle(`agent-run-${runId}`).signal("agent.approval", signal);
}

export async function signalRunCancellation(client: Client, runId: string, signal: CancellationSignal = {}): Promise<void> {
  await client.workflow.getHandle(`agent-run-${runId}`).signal("agent.cancel", signal);
}
