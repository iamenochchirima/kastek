import test from "node:test";
import assert from "node:assert/strict";
import { formatSerdeJsonSyntaxError } from "../dist/json.js";

test("Node JSON syntax diagnostics match common Serde messages without echoing input", () => {
  const cases = [
    ["{", "EOF while parsing an object at line 1 column 1"],
    ["{x}", "key must be a string at line 1 column 2"],
    ["[1,]", "trailing comma at line 1 column 4"],
    ["[1", "EOF while parsing a list at line 1 column 2"],
    ["[1 2]", "expected `,` or `]` at line 1 column 4"],
    ['{"name":1', "EOF while parsing an object at line 1 column 9"],
    ['{"a" 1}', "expected `:` at line 1 column 6"],
    ['{"a":1 "b":2}', "expected `,` or `}` at line 1 column 8"],
    ['{"name":1,}', "trailing comma at line 1 column 11"],
    ["01", "invalid number at line 1 column 2"],
    ['"x', "EOF while parsing a string at line 1 column 2"],
    ["true false", "trailing characters at line 1 column 6"],
    ['{"secret": nope}', "expected ident at line 1 column 13"],
    [String.raw`{"name":"\q"}`, "invalid escape at line 1 column 11"],
  ];

  for (const [source, expected] of cases) {
    let error;
    try {
      JSON.parse(source);
    } catch (caught) {
      error = caught;
    }
    const actual = formatSerdeJsonSyntaxError(source, error);
    assert.equal(actual, expected);
    assert.equal(actual.includes(source), false);
  }
});
