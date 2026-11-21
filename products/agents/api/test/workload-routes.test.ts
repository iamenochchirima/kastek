import { describe, expect, it } from "vitest";
import { workerAcceptsWorkload, workerRoleFromEnvironment, workerRoleWorkload, workerRunsBusiness, workerRunsIngestion, workloadClass, workloadPoolsFromEnvironment } from "../src/execution/scheduling/workload-routes";

describe("workload routing", () => {
  it("classifies conversation turns as interactive and everything else as background", () => {
    expect(workloadClass("interactive")).toBe("interactive");
    expect(workloadClass("background")).toBe("background");
    expect(workloadClass("ingestion")).toBe("background");
    expect(workloadClass("sandbox")).toBe("background");
  });
  it("gives ingestion its own worker role and limits business roles to their workload", () => {
    const ingestion = workerRoleFromEnvironment({ AGENTS_WORKER_ROLE: "ingestion" });
    expect(workerRunsIngestion(ingestion)).toBe(true);
    expect(workerRunsBusiness(ingestion)).toBe(false);
    expect(workerRoleWorkload(ingestion)).toBeUndefined();
    expect(workerRunsBusiness(workerRoleFromEnvironment({ AGENTS_WORKER_ROLE: "interactive" }))).toBe(true);
    expect(workerRunsIngestion(workerRoleFromEnvironment({ AGENTS_WORKER_ROLE: "background" }))).toBe(false);
    expect(workerRoleWorkload(workerRoleFromEnvironment({ AGENTS_WORKER_ROLE: "background" }))).toBe("background");
    expect(workerRoleFromEnvironment({})).toBe("all");
    expect(() => workerRoleFromEnvironment({ AGENTS_WORKER_ROLE: "everything" })).toThrow();
  });
  it("routes to the configured pool and stays unrestricted when unset", () => {
    const pools = workloadPoolsFromEnvironment({ AGENTS_WORKER_POOL_INTERACTIVE: "replies", AGENTS_WORKER_POOL_BACKGROUND: "jobs" });
    expect(workerAcceptsWorkload("interactive", "replies", pools)).toBe(true);
    expect(workerAcceptsWorkload("interactive", "jobs", pools)).toBe(false);
    expect(workerAcceptsWorkload("background", "jobs", pools)).toBe(true);
    const unrestricted = workloadPoolsFromEnvironment({});
    expect(workerAcceptsWorkload("background", null, unrestricted)).toBe(true);
  });
});
