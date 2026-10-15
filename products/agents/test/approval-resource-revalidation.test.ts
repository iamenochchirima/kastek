import { describe, expect, it } from "vitest";
import { approvalResourceSnapshotsEqual } from "../src/approval/resource-revalidation";

describe("approval resource revalidation", () => {
  it("ignores object key order while comparing the reviewed projection", () => {
    expect(approvalResourceSnapshotsEqual(
      { resource: { id: "event-1", status: "scheduled" }, request: { calendarId: "cal-1", eventId: "event-1" } },
      { request: { eventId: "event-1", calendarId: "cal-1" }, resource: { status: "scheduled", id: "event-1" } },
    )).toBe(true);
  });

  it("fails closed when a reviewed resource or request changes", () => {
    const reviewed = { resource: { id: "event-1", status: "scheduled" } };
    expect(approvalResourceSnapshotsEqual(reviewed, { resource: { id: "event-1", status: "cancelled" } })).toBe(false);
    expect(approvalResourceSnapshotsEqual(reviewed, { resource: { id: "event-2", status: "scheduled" } })).toBe(false);
    expect(approvalResourceSnapshotsEqual(reviewed, undefined)).toBe(false);
  });
});
