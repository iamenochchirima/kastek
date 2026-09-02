import { describe, expect, it } from "vitest";
import { buildApprovedToolCompletionMessage } from "../src/runtime/approved-tool-completion";

describe("approved batch completion", () => {
  const args = { postId: "post-1" };

  it("reports every confirmed destination on success", () => {
    expect(buildApprovedToolCompletionMessage("kasitek.core.content_post_publish_batch", args, {
      post: { title: "Launch", channels: ["INSTAGRAM", "X"] },
      batch: {
        status: "SUCCEEDED",
        targets: [
          { platform: "INSTAGRAM", accountName: "KasiTek", state: "PUBLISHED" },
          { platform: "X", accountName: "KasiTek Labs", state: "PUBLISHED" },
        ],
      },
    })).toBe("Published “Launch” to Instagram (KasiTek), X (KasiTek Labs).");
  });

  it("keeps partial results and identifies destinations needing attention", () => {
    expect(buildApprovedToolCompletionMessage("kasitek.core.content_post_publish_batch", args, {
      post: { title: "Launch" },
      batch: {
        status: "PARTIAL",
        targets: [
          { platform: "THREADS", accountName: "KasiTek", state: "PUBLISHED" },
          { platform: "LINKEDIN", accountName: "Company Page", state: "FAILED" },
        ],
      },
    })).toBe("Published to Threads (KasiTek). LinkedIn (Company Page) still need attention.");
  });

  it("does not claim a processing batch was published", () => {
    expect(buildApprovedToolCompletionMessage("kasitek.core.content_post_publish_batch", args, {
      post: { title: "Launch" },
      batch: {
        status: "PROCESSING",
        targets: [{ platform: "INSTAGRAM", accountName: "KasiTek", state: "PROCESSING" }],
      },
    })).toBe("Publishing “Launch” to Instagram (KasiTek).");
  });

  it("reports actionable remediation without claiming an unknown result", () => {
    expect(buildApprovedToolCompletionMessage("kasitek.core.content_post_publish_batch", args, {
      post: { title: "Launch" },
      batch: {
        status: "UNKNOWN",
        targets: [{ platform: "INSTAGRAM", accountName: "KasiTek", state: "UNKNOWN", remediationMode: "RECONCILE" }],
      },
    })).toBe("The batch publish for “Launch” could not be confirmed for Instagram (KasiTek). Reconcile the provider result before retrying.");
  });

  it("keeps batch retries scoped to confirmed failed destinations", () => {
    expect(buildApprovedToolCompletionMessage("kasitek.core.content_post_publish_batch_retry", { batchId: "batch-1" }, {
      post: { title: "Launch" },
      batch: {
        status: "PROCESSING",
        targets: [{ platform: "INSTAGRAM", accountName: "KasiTek", state: "PROCESSING" }],
      },
    })).toBe("Retrying the failed destinations for “Launch”.");
  });
});
