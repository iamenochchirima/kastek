import test from "node:test";
import assert from "node:assert/strict";
import { apiJson, serdeFloat } from "../dist/json.js";

test("service JSON replies keep Rust-compatible null, ordering and numeric semantics", () => {
  class MicrosecondDate extends Date {
    toISOString() {
      return "2030-01-02T03:04:05.123456Z";
    }
  }

  assert.equal(
    apiJson({
      z: "last",
      omitted: undefined,
      nullable: null,
      timestamp: new MicrosecondDate("2030-01-02T03:04:05.123Z"),
      identifier: 9007199254740993n,
      ratio: serdeFloat(12),
      values: [undefined, null, { b: 2, a: 1 }],
    }),
    '{"identifier":9007199254740993,"nullable":null,"ratio":12.0,"timestamp":"2030-01-02T03:04:05.123456Z","values":[null,null,{"a":1,"b":2}],"z":"last"}',
  );
});
