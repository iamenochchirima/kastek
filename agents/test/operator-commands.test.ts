import { describe, expect, it } from "vitest";
import {
  operatorCommandInputSchema,
  publicOperatorCommand,
  requiredApprovals,
  type OperatorCommandRecord,
} from "../src/http/operator-commands";

describe("operator command contract", () => {
  it("requires a second operator for effect and kill-switch mutations", () => {
    expect(requiredApprovals("cancel_run")).toBe(1);
    expect(requiredApprovals("retry_run")).toBe(2);
    expect(requiredApprovals("retry_audio_transcription")).toBe(2);
    expect(requiredApprovals("replay_delivery")).toBe(2);
    expect(requiredApprovals("delete_memory")).toBe(2);
    expect(requiredApprovals("assign_run")).toBe(2);
    expect(requiredApprovals("reconcile_effect")).toBe(2);
    expect(requiredApprovals("request_export")).toBe(2);
    expect(requiredApprovals("set_feature_flag")).toBe(2);
    expect(requiredApprovals("clear_feature_flag")).toBe(2);
    expect(requiredApprovals("create_hold")).toBe(2);
    expect(requiredApprovals("release_hold")).toBe(2);
    expect(requiredApprovals("set_retention_policy")).toBe(2);
    expect(requiredApprovals("apply_retention_policy")).toBe(2);
    expect(requiredApprovals("create_legal_hold")).toBe(2);
    expect(requiredApprovals("release_legal_hold")).toBe(2);
    expect(requiredApprovals("kill_switch_enable")).toBe(2);
    expect(requiredApprovals("kill_switch_disable")).toBe(2);
    expect(requiredApprovals("suspend_installation")).toBe(2);
    expect(requiredApprovals("resume_installation")).toBe(2);
    expect(requiredApprovals("revoke_credential")).toBe(2);
    expect(requiredApprovals("pause_schedule")).toBe(2);
    expect(requiredApprovals("resume_schedule")).toBe(2);
  });

  it("keeps every mutating command explicit, bounded, and dual-controlled", () => {
    const dualControlCommands = [
      "retry_run",
      "retry_audio_transcription",
      "replay_delivery",
      "delete_memory",
      "assign_run",
      "reconcile_effect",
      "request_export",
      "set_feature_flag",
      "clear_feature_flag",
      "create_hold",
      "release_hold",
      "set_retention_policy",
      "apply_retention_policy",
      "create_legal_hold",
      "release_legal_hold",
      "kill_switch_enable",
      "kill_switch_disable",
      "suspend_installation",
      "resume_installation",
      "revoke_credential",
      "pause_schedule",
      "resume_schedule",
    ] as const;
    expect(new Set(dualControlCommands).size).toBe(dualControlCommands.length);
    for (const commandType of dualControlCommands) {
      expect(requiredApprovals(commandType)).toBe(2);
      expect(operatorCommandInputSchema.parse({ commandType, targetId: "target-1" })).toMatchObject({
        commandType,
        targetId: "target-1",
        payload: {},
      });
    }
    expect(requiredApprovals("cancel_run")).toBe(1);
    expect(operatorCommandInputSchema.parse({ commandType: "cancel_run", targetId: "run-1" })).toMatchObject({
      commandType: "cancel_run",
      payload: {},
    });
    expect(() => operatorCommandInputSchema.parse({ commandType: "delete_all", targetId: "target-1" })).toThrow();
    expect(() => operatorCommandInputSchema.parse({ commandType: "retry_run", targetId: "" })).toThrow();
    expect(() => operatorCommandInputSchema.parse({ commandType: "retry_run", targetId: "target-1", payload: { unexpected: true }, extra: true })).toThrow();
  });

  it("defaults payloads but rejects unknown command fields", () => {
    expect(operatorCommandInputSchema.parse({ commandType: "cancel_run", targetId: "run-1" })).toEqual({
      commandType: "cancel_run",
      targetId: "run-1",
      payload: {},
    });
    expect(() => operatorCommandInputSchema.parse({ commandType: "cancel_run", targetId: "run-1", approvedBy: "spoofed" })).toThrow();
  });

  it("projects command status without payload or provider receipt material", () => {
    const command: OperatorCommandRecord = {
      id: "command-1",
      command_type: "reconcile_effect",
      target_id: "effect-1",
      actor_id: "operator-1",
      organization_id: "org-1",
      payload: { providerReceipt: { accessToken: "secret" }, error: { raw: "customer content" } },
      status: "completed",
      required_approvals: 2,
      approvers: ["operator-1", "operator-2"],
      idempotency_key: "reconcile-effect-1",
      result: { status: "succeeded", effectId: "effect-1", providerReceipt: { accessToken: "secret" } },
      error: null,
      created_at: "2026-08-14T00:00:00.000Z",
      updated_at: "2026-08-14T00:00:01.000Z",
      completed_at: "2026-08-14T00:00:01.000Z",
    };
    const projection = publicOperatorCommand(command);
    expect(projection).toMatchObject({ id: "command-1", status: "completed", result: { status: "succeeded", effectId: "effect-1" } });
    expect(JSON.stringify(projection)).not.toContain("accessToken");
    expect(JSON.stringify(projection)).not.toContain("customer content");
    for (const forbidden of ["payload", "providerReceipt", "accessToken", "raw", "customer content"]) {
      expect(JSON.stringify(projection)).not.toContain(forbidden);
    }
  });
});
