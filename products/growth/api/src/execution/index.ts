import type {
  ActionDefinition,
  ActionOutcome,
  ActionResult,
  DenialCode,
  FailureCode,
  IncomingActionRequest,
  ValidatedActionRequest,
} from "../actions/index.js";
import { ActionRegistry } from "../actions/index.js";
export type GateDecision =
  | {
      type: "allow";
    }
  | {
      type: "deny";
      code: DenialCode;
    };
export type PolicyDecision =
  | GateDecision
  | {
      type: "approval_required";
      approval_id: string;
    };
export type IdempotencyDecision =
  | {
      type: "proceed";
    }
  | {
      type: "existing";
      outcome: ActionOutcome;
    };
export type RunOutput =
  | {
      type: "completed";
      output: unknown;
    }
  | {
      type: "accepted";
      operation_id: string;
    };
export type JournalOutcome =
  | {
      type: "denied";
      code: DenialCode;
    }
  | {
      type: "approval_required";
      approval_id: string;
    }
  | {
      type: "succeeded";
    }
  | {
      type: "accepted";
      operation_id: string;
    }
  | {
      type: "failed";
      code: FailureCode;
    };
export class PortError extends Error {
  constructor(readonly code: FailureCode) {
    super(`execution dependency failed with ${code}`);
    this.name = "PortError";
  }
  static unavailable(): PortError {
    return new PortError("temporarily_unavailable");
  }
  static internal(): PortError {
    return new PortError("internal");
  }
}
export class RunHandle {
  constructor(readonly id: string) {
    if (!id.trim()) throw PortError.internal();
  }
}
export interface GatePort {
  evaluate(
    request: ValidatedActionRequest,
    action: ActionDefinition,
  ): Promise<GateDecision>;
}
export interface ExecutionPorts {
  clock: {
    now(): Date;
  };
  identity: GatePort;
  access: GatePort;
  entitlements: GatePort;
  policy: {
    evaluate(
      request: ValidatedActionRequest,
      action: ActionDefinition,
    ): Promise<PolicyDecision>;
  };
  idempotency: {
    evaluate(
      request: ValidatedActionRequest,
      action: ActionDefinition,
    ): Promise<IdempotencyDecision>;
  };
  journal: {
    recordDecision(
      request: ValidatedActionRequest,
      outcome: JournalOutcome,
    ): Promise<void>;
    start(
      request: ValidatedActionRequest,
      action: ActionDefinition,
    ): Promise<RunHandle>;
    finish(run: RunHandle, outcome: JournalOutcome): Promise<void>;
  };
  runner: {
    run(
      request: ValidatedActionRequest,
      action: ActionDefinition,
    ): Promise<RunOutput>;
  };
}
const failed = (error_code: FailureCode): ActionOutcome => ({
  status: "failed",
  error_code,
});
const dependency = (error: unknown): FailureCode =>
  error instanceof PortError ? error.code : "internal";
export class ExecutionPipeline {
  constructor(
    private registry: ActionRegistry,
    private ports: ExecutionPorts,
  ) {}
  private result(
    request: ValidatedActionRequest,
    outcome: ActionOutcome,
  ): ActionResult {
    return {
      invocation_id: request.incoming.invocation_id,
      correlation_id: request.incoming.correlation_id,
      outcome,
    };
  }
  private async decision(
    request: ValidatedActionRequest,
    journal: JournalOutcome,
    outcome: ActionOutcome,
  ): Promise<ActionResult> {
    try {
      await this.ports.journal.recordDecision(request, journal);
    } catch (error) {
      outcome = failed(dependency(error));
    }
    return this.result(request, outcome);
  }
  private failure(
    request: ValidatedActionRequest,
    code: FailureCode,
  ): Promise<ActionResult> {
    return this.decision(request, { type: "failed", code }, failed(code));
  }
  private denial(
    request: ValidatedActionRequest,
    code: DenialCode,
  ): Promise<ActionResult> {
    return this.decision(
      request,
      { type: "denied", code },
      { status: "denied", reason_code: code },
    );
  }
  async execute(incoming: IncomingActionRequest): Promise<ActionResult> {
    const request = this.registry.validateRequest(incoming),
      action = this.registry.get(request.incoming.action).definition;
    if (incoming.deadline && incoming.deadline <= this.ports.clock.now())
      return this.failure(request, "deadline_exceeded");
    for (const port of [
      this.ports.identity,
      this.ports.access,
      this.ports.entitlements,
    ]) {
      try {
        const decision = await port.evaluate(request, action);
        if (decision.type === "deny")
          return this.denial(request, decision.code);
      } catch (error) {
        return this.failure(request, dependency(error));
      }
    }
    try {
      const policy = await this.ports.policy.evaluate(request, action);
      if (policy.type === "deny") return this.denial(request, policy.code);
      if (policy.type === "approval_required") {
        if (!policy.approval_id.trim())
          return this.failure(request, "internal");
        return this.decision(
          request,
          { type: "approval_required", approval_id: policy.approval_id },
          { status: "approval_required", approval_id: policy.approval_id },
        );
      }
    } catch (error) {
      return this.failure(request, dependency(error));
    }
    try {
      const decision = await this.ports.idempotency.evaluate(request, action);
      if (decision.type === "existing")
        return this.result(request, decision.outcome);
    } catch (error) {
      return this.failure(request, dependency(error));
    }
    let run: RunHandle;
    try {
      run = await this.ports.journal.start(request, action);
    } catch (error) {
      return this.result(request, failed(dependency(error)));
    }
    let journal: JournalOutcome, outcome: ActionOutcome;
    try {
      const result = await this.ports.runner.run(request, action);
      if (result.type === "completed") {
        try {
          this.registry.validateOutput(action.id, result.output);
          journal = { type: "succeeded" };
          outcome = { status: "succeeded", output: result.output };
        } catch {
          journal = { type: "failed", code: "invalid_output" };
          outcome = failed("invalid_output");
        }
      } else if (result.operation_id.trim()) {
        journal = { type: "accepted", operation_id: result.operation_id };
        outcome = { status: "accepted", operation_id: result.operation_id };
      } else {
        journal = { type: "failed", code: "internal" };
        outcome = failed("internal");
      }
    } catch (error) {
      journal = { type: "failed", code: dependency(error) };
      outcome = failed(dependency(error));
    }
    try {
      await this.ports.journal.finish(run, journal);
    } catch (error) {
      return this.result(request, failed(dependency(error)));
    }
    return this.result(request, outcome);
  }
}
