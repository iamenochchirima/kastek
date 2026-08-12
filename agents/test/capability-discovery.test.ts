import { describe, expect, it } from "vitest";
import { createDefaultTools } from "../src/temporal/activities";

describe("capability discovery", () => {
  it("contains manifest metadata for the default platform tools", () => {
    const manifests = createDefaultTools().manifests();
    expect(manifests.map((manifest) => manifest.name)).toEqual([
      "platform.current_time",
      "kasitek.core.customer_get",
      "kasitek.core.workspace_status",
    ]);
    expect(manifests[1]?.manifest).toMatchObject({ ownerService: "kasitek-core", requiredScope: "customers.read" });
  });
});
