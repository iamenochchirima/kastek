import {describe, expect, it} from "vitest";
import {redactToolOutput} from "../src/tools/redaction";

describe("tool output timestamp redaction", () => {
  it("preserves PostgreSQL event times while redacting attendees and secrets", () => {
    expect(redactToolOutput({events:[{start:new Date("2026-10-07T10:00:00Z"),end:new Date("2026-10-07T10:30:00Z"),attendees:["private@example.test"]}],accessToken:"private-token"},["events.attendees"])).toEqual({events:[{start:"2026-10-07T10:00:00.000Z",end:"2026-10-07T10:30:00.000Z",attendees:"[REDACTED]"}],accessToken:"[REDACTED]"});
  });
  it("uses JSON-compatible null for invalid dates", () => {
    expect(redactToolOutput({time:new Date("invalid")},[])).toEqual({time:null});
  });
});
