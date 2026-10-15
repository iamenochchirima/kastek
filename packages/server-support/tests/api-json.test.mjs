import test from "node:test";
import assert from "node:assert/strict";
import { apiJson, canonicalJson, serdeFloat } from "../dist/json.js";

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

test("service JSON replies serialize byte vectors as Rust-compatible arrays", () => {
  const money = "12345678901234567890.123456789";
  const bytes = Buffer.from([0, 1, 127, 128, 255]);
  const typedBytes = new Uint8Array([3, 4, 5]);

  assert.equal(
    apiJson({ money, bytes, typedBytes }),
    '{"bytes":[0,1,127,128,255],"money":"12345678901234567890.123456789","typedBytes":[3,4,5]}',
  );
  assert.equal(canonicalJson(bytes), "[0,1,127,128,255]");
});

test("service JSON replies omit zero date fractions like Chrono", () => {
  assert.equal(
    apiJson({ occurredAt: new Date("2030-01-02T03:04:05.000Z") }),
    '{"occurredAt":"2030-01-02T03:04:05Z"}',
  );
});
