import { describe, expect, it } from "vitest";
import { compareDatabaseTimestampsDesc } from "../src/db/timestamps";

describe("database timestamp ordering", () => {
  it("orders PostgreSQL Date values and ISO strings consistently", () => {
    const older = new Date("2026-09-10T10:00:00.000Z");
    const newer = "2026-09-10T11:00:00.000Z";
    expect(compareDatabaseTimestampsDesc(older, newer)).toBeGreaterThan(0);
    expect(compareDatabaseTimestampsDesc(newer, older)).toBeLessThan(0);
  });

  it("puts malformed timestamps last without throwing", () => {
    expect(() => compareDatabaseTimestampsDesc("not-a-timestamp", new Date("2026-09-10T11:00:00.000Z"))).not.toThrow();
    expect(compareDatabaseTimestampsDesc("not-a-timestamp", new Date("2026-09-10T11:00:00.000Z"))).toBeGreaterThan(0);
    expect(() => compareDatabaseTimestampsDesc(new Date("not-a-timestamp"), new Date("2026-09-10T11:00:00.000Z"))).not.toThrow();
  });
});
