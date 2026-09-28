import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import type { AppConfig } from "../config";
import type { DurableRunInput } from "./contracts";
import type { ApprovalGroupSignal, CancellationSignal, ExternalEventSignal } from "./contracts";
import { agentRunWorkflow } from "./workflows";
import { temporalClientInterceptor } from "../telemetry/temporal";

export async function connectTemporal(config: AppConfig): Promise<{ connection: Connection; client: Client }> {
  const connection = await Connection.connect({
    address: config.TEMPORAL_ADDRESS,
    apiKey: config.TEMPORAL_API_KEY || undefined,
    tls: config.TEMPORAL_MODE === "cloud" ? {} : undefined,
  });
  return {
    connection,
    client: new Client({
      connection,
      namespace: config.TEMPORAL_NAMESPACE,
      interceptors: { workflow: [temporalClientInterceptor] },
    }),
  };
}

export async function startDurableRun(
  client: Client,
  config: AppConfig,
  input: DurableRunInput,
): Promise<void> {
  try {
    await client.workflow.start(agentRunWorkflow, {
      workflowId: `agent-run-${input.runId}`,
      taskQueue: config.TEMPORAL_TASK_QUEUE,
      args: [input],
    });
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) return;
    throw error;
  }
}

export async function signalRunApprovalGroup(client: Client, runId: string, signal: ApprovalGroupSignal): Promise<void> {
  await client.workflow.getHandle(`agent-run-${runId}`).signal("agent.approval-group", signal);
}

export async function signalRunCancellation(client: Client, runId: string, signal: CancellationSignal = {}): Promise<void> {
  await client.workflow.getHandle(`agent-run-${runId}`).signal("agent.cancel", signal);
}

export async function signalRunExternalEvent(client: Client, runId: string, signal: ExternalEventSignal): Promise<void> {
  await client.workflow.getHandle(`agent-run-${runId}`).signal("agent.external-event", signal);
}
