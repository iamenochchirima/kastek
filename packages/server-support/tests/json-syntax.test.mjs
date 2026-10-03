import test from "node:test";
import assert from "node:assert/strict";
import {
  parseLosslessJson,
  parseSerdeValueJson,
  formatSerdeJsonSyntaxError,
  formatSerdeValidationError,
} from "../dist/json.js";

test("Node JSON syntax diagnostics match common Serde messages without echoing input", () => {
  const cases = [
    ["{", "EOF while parsing an object at line 1 column 1"],
    ["{x}", "key must be a string at line 1 column 2"],
    ["[1,]", "trailing comma at line 1 column 4"],
    ["[1,}", "expected value at line 1 column 4"],
    ["[1, }", "expected value at line 1 column 5"],
    ["[1", "EOF while parsing a list at line 1 column 2"],
    ["[1 2]", "expected `,` or `]` at line 1 column 4"],
    ['{"name":1', "EOF while parsing an object at line 1 column 9"],
    ['{"a" 1}', "expected `:` at line 1 column 6"],
    ['{"a":1 "b":2}', "expected `,` or `}` at line 1 column 8"],
    ['{"name":1,}', "trailing comma at line 1 column 11"],
    ['{"a":1,]', "key must be a string at line 1 column 8"],
    ['{"a":1, ]', "key must be a string at line 1 column 9"],
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

test("JSON parsers reject lone UTF-16 surrogate escapes like Serde", () => {
  for (const [source, expected] of [
    [String.raw`"\uDC00"`, "lone leading surrogate in hex escape at line 1 column 7"],
    [String.raw`"\uD800"`, "unexpected end of hex escape at line 1 column 8"],
    [String.raw`"\uD83C\uFFFF"`, "lone leading surrogate in hex escape at line 1 column 13"],
    [String.raw`{"\uDC00":1}`, "lone leading surrogate in hex escape at line 1 column 8"],
  ]) {
    for (const parse of [parseLosslessJson, parseSerdeValueJson]) {
      assert.throws(parse.bind(null, source), (error) =>
        formatSerdeJsonSyntaxError(source, error) === expected,
      );
    }
  }
  assert.equal(parseSerdeValueJson(String.raw`"\uD83D\uDE00"`), "😀");
  assert.equal(parseSerdeValueJson(String.raw`"\\uD800"`), "\\uD800");
});

test("schema validation diagnostics describe types without reflecting values", () => {
  assert.equal(
    formatSerdeValidationError(
      [{ keyword: "required", params: { missingProperty: "name" } }],
      "body",
      {},
    ),
    "missing field `name`",
  );
  const detail = formatSerdeValidationError(
    [
      {
        keyword: "type",
        instancePath: "/credentials/password",
        params: { type: "string" },
      },
    ],
    "body",
    { credentials: { password: false } },
  );
  assert.equal(
    detail,
    "invalid type: a boolean, expected a string at `body.credentials.password`",
  );
  assert.equal(detail.includes("false"), false);
});
