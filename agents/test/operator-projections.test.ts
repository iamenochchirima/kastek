import { describe, expect, it } from "vitest";
import { buildOperatorAlertNotificationSeeds } from "../src/http/operator-projections";

describe("operator alert notifications", () => {
  it("covers each local incident category without copying sensitive payloads", () => {
    const notifications = buildOperatorAlertNotificationSeeds({
      reconciliationRequired: 1,
      failedRunsLast24h: 1,
      queuedRunsOver15m: 1,
      failedDeliveriesLast24h: 1,
      failedModelCallsLast24h: 1,
      providerFailuresLast24h: { openai: 2 },
      credentialRevocationsLast24h: 1,
      dataAccessEventsLast24h: 1,
    });
    expect(new Set(notifications.map((notification) => notification.kind))).toEqual(new Set([
      "duplicate_effect",
      "stuck_run",
      "queue_backlog",
      "webhook_storm",
      "model_outage",
      "provider_outage",
      "credential_compromise",
      "data_access",
    ]));
    expect(JSON.stringify(notifications)).not.toContain("prompt");
    expect(JSON.stringify(notifications)).not.toContain("token");
    expect(notifications.find((notification) => notification.kind === "provider_outage")).toMatchObject({ metadata: { provider: "openai", count: 2 } });
  });
});
