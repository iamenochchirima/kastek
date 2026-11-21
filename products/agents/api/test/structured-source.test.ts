import { describe, expect, it } from "vitest";
import { convertStructuredSource, csvToMarkdown, jsonToMarkdown, parseCsv } from "../src/platform/knowledge/structured-source";

describe("structured knowledge sources", () => {
  it("turns JSON records into retrievable blocks with inherited context", () => {
    const markdown = jsonToMarkdown(JSON.stringify({
      brand: "Sandwich Baron",
      order_url: "https://example.test/order",
      categories: [{
        name: "Sandwiches",
        category_url: "https://example.test/sandwiches",
        items: [{ name: "Chicken Mayo", price: { sandwich: "R47", french: "R65", footlong: "R87" } }],
      }],
    }));
    expect(markdown).toContain("Chicken Mayo");
    expect(markdown).toContain("price.sandwich: R47");
    expect(markdown).toContain("price.footlong: R87");
    expect(markdown).toContain("category_url: https://example.test/sandwiches");
    expect(markdown).toContain("order_url: https://example.test/order");
  });

  it("keeps top-level arrays and scalar arrays readable", () => {
    const markdown = jsonToMarkdown(JSON.stringify([{ name: "Alberton", hours: "08:00-16:30" }, { name: "Boksburg", hours: "08:00-16:30" }]));
    expect(markdown).toContain("Alberton");
    expect(markdown).toContain("- hours: 08:00-16:30");
    expect(jsonToMarkdown(JSON.stringify({ tags: ["a", "b"] }))).toContain("- tags: a, b");
  });

  it("rejects malformed JSON and empty content", () => {
    expect(() => jsonToMarkdown("{")).toThrow(expect.objectContaining({ code: "SOURCE_FORMAT_INVALID" }));
    expect(() => convertStructuredSource("application/json", Buffer.from("  "))).toThrow(expect.objectContaining({ code: "SOURCE_FORMAT_INVALID" }));
  });

  it("parses quoted CSV fields, commas and newlines", () => {
    const rows = parseCsv('Name,Note\r\n"Chicken Mayo","R47, toasted"\r\n"Bacon ""and"" Cheese","line one\nline two"\r\n');
    expect(rows).toEqual([["Name", "Note"], ["Chicken Mayo", "R47, toasted"], ['Bacon "and" Cheese', "line one\nline two"]]);
    const markdown = csvToMarkdown('Name,Price\nChicken Mayo,"R47, toasted"\n');
    expect(markdown).toContain("### Chicken Mayo");
    expect(markdown).toContain("- Price: R47, toasted");
  });

  it("rejects CSV without data rows", () => {
    expect(() => csvToMarkdown("Name,Price\n")).toThrow(expect.objectContaining({ code: "SOURCE_FORMAT_INVALID" }));
  });

  it("normalizes a UTF-8 BOM and records the normalizer provenance", () => {
    const text = convertStructuredSource("text/csv", Buffer.from("\uFEFFName,Price\nTuna Mayo,R45\n"));
    expect(text).toContain("structured-source-v1");
    expect(text).toContain("### Tuna Mayo");
  });
});
