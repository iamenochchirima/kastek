import { describe, expect, it } from "vitest";
import { supportHoursSchema } from "../src/contracts/customer-setup";

describe("support hours", () => {
  it("accepts an explicit non-contiguous schedule and a full day", () => {
    expect(supportHoursSchema.safeParse({ timeZone: "Africa/Johannesburg", intervals: [
      { day: 1, start: "09:00", end: "12:00" }, { day: 1, start: "13:00", end: "17:00" }, { day: 6, start: "00:00", end: "24:00" },
    ] }).success).toBe(true);
  });
  it.each([
    { timeZone: "Made/Up", intervals: [{ day: 1, start: "09:00", end: "17:00" }] },
    { timeZone: "UTC", intervals: [] },
    { timeZone: "UTC", intervals: [{ day: 1, start: "17:00", end: "09:00" }] },
    { timeZone: "UTC", intervals: [{ day: 1, start: "00:00", end: "24:01" }] },
    { timeZone: "UTC", intervals: [{ day: 1, start: "09:00", end: "12:00" }, { day: 1, start: "11:00", end: "17:00" }] },
  ])("rejects invalid or ambiguous hours", value => {
    expect(supportHoursSchema.safeParse(value).success).toBe(false);
  });
});
