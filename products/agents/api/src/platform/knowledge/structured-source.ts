import { PlatformError } from "../../contracts/contracts";
import { SOURCE_LIMITS } from "../../contracts/source-contracts";

export const STRUCTURED_CONTENT_TYPES = Object.freeze(["application/json", "text/csv"] as const);
export type StructuredContentType = (typeof STRUCTURED_CONTENT_TYPES)[number];
export const STRUCTURED_SOURCE_RELEASE = "structured-source-v1";

const MAX_NODES = 20_000;
const MAX_DEPTH = 12;
const MAX_ROWS = 10_000;
const MAX_CELLS = 200_000;

function invalid(message: string) {
  return new PlatformError("SOURCE_FORMAT_INVALID", 400, message);
}

function plain(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value.replace(/\s+/gu, " ").trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? "";
}

function labelOf(value: Record<string, unknown>, fallback: string): string {
  for (const key of ["name", "title", "label", "id"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.replace(/\s+/gu, " ").trim();
    if (typeof candidate === "number") return String(candidate);
  }
  return fallback;
}

function heading(text: string, level: number): string {
  return `${"#".repeat(Math.min(6, Math.max(1, level)))} ${text.replace(/\s+/gu, " ").trim()}`;
}

function scalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function inlineArray(value: unknown[]): string | null {
  if (!value.every(scalar)) return null;
  return value.map(plain).join(", ");
}

class Renderer {
  readonly lines: string[] = [];
  private nodes = 0;

  push(line: string) {
    if (line) this.lines.push(line);
  }

  count() {
    this.nodes++;
    if (this.nodes > MAX_NODES) throw invalid("The file has too many values to index");
  }

  render(value: unknown, context: Record<string, string>, level: number, depth = 0, key?: string) {
    this.count();
    if (depth > MAX_DEPTH) throw invalid("The file is nested too deeply to index");
    if (scalar(value)) {
      this.push(`- ${key ?? "value"}: ${plain(value)}`);
      return;
    }
    if (Array.isArray(value)) {
      if (!value.length) {
        if (key) this.push(`- ${key}: []`);
        return;
      }
      const inline = inlineArray(value);
      if (inline !== null) {
        if (key) this.push(`- ${key}: ${inline}`);
        else for (const item of value) this.push(`- ${plain(item)}`);
        return;
      }
      if (key) this.push(heading(key, level));
      for (const [index, item] of value.entries()) {
        if (scalar(item)) {
          this.push(`- ${plain(item)}`);
          continue;
        }
        if (Array.isArray(item)) {
          this.render(item, context, level + 1, depth + 1, `Item ${index + 1}`);
          continue;
        }
        const record = item as Record<string, unknown>;
        const label = labelOf(record, `${key ?? "Item"} ${index + 1}`);
        this.push(heading(label, level + 1));
        this.renderObject(record, context, level + 2, depth + 1, new Set(["name", "title", "label", "id"]));
      }
      return;
    }
    const record = value as Record<string, unknown>;
    if (key) this.push(heading(key, level));
    this.renderObject(record, context, level + 1, depth, new Set());
  }

  private renderObject(value: Record<string, unknown>, context: Record<string, string>, level: number, depth: number, skip: Set<string>) {
    const own = Object.fromEntries(Object.entries(value).filter(([key]) => !skip.has(key)).map(([key, item]) => [key, scalar(item) ? plain(item) : undefined]).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const merged = { ...context, ...own };
    for (const [key, item] of Object.entries(value)) {
      this.count();
      if (skip.has(key)) continue;
      if (scalar(item)) {
        this.push(`- ${key}: ${plain(item)}`);
        continue;
      }
      if (Array.isArray(item)) {
        const inline = inlineArray(item);
        if (inline !== null) this.push(`- ${key}: ${inline}`);
        else this.render(item, merged, level, depth + 1, key);
        continue;
      }
      this.flatten(item as Record<string, unknown>, key, depth + 1);
    }
    // Parent values stay with each record so a single passage still carries its context.
    for (const [key, item] of Object.entries(context)) if (!(key in value) && !skip.has(key)) this.push(`- ${key}: ${item}`);
  }

  private flatten(value: Record<string, unknown>, prefix: string, depth: number) {
    if (depth > MAX_DEPTH) throw invalid("The file is nested too deeply to index");
    for (const [key, item] of Object.entries(value)) {
      this.count();
      const name = `${prefix}.${key}`;
      if (scalar(item)) {
        this.push(`- ${name}: ${plain(item)}`);
        continue;
      }
      if (Array.isArray(item)) {
        const inline = inlineArray(item);
        if (inline !== null) this.push(`- ${name}: ${inline}`);
        else this.render(item, {}, 3, depth + 1, name);
        continue;
      }
      this.flatten(item as Record<string, unknown>, name, depth + 1);
    }
  }
}

export function jsonToMarkdown(text: string): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid("The JSON file could not be parsed");
  }
  const renderer = new Renderer();
  renderer.render(value, {}, 2);
  return renderer.lines.join("\n");
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let cells = 0;
  const pushField = () => {
    row.push(field);
    field = "";
    cells++;
    if (cells > MAX_CELLS) throw invalid("The CSV file has too many cells to index");
  };
  const pushRow = () => {
    pushField();
    if (row.some(cell => cell.trim())) rows.push(row);
    if (rows.length > MAX_ROWS + 1) throw invalid("The CSV file has too many rows to index");
    row = [];
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field.length === 0) {
      quoted = true;
      continue;
    }
    if (char === ",") {
      pushField();
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      pushRow();
      continue;
    }
    field += char;
  }
  if (quoted) throw invalid("The CSV file has an unclosed quoted field");
  if (field.length || row.length) pushRow();
  return rows;
}

export function csvToMarkdown(text: string): string {
  const rows = parseCsv(text);
  if (rows.length < 2) throw invalid("The CSV file needs a header row and at least one data row");
  const headers = rows[0]!.map((header, index) => header.trim() || `Column ${index + 1}`);
  const seen = new Map<string, number>();
  const unique = headers.map(header => {
    const count = (seen.get(header) ?? 0) + 1;
    seen.set(header, count);
    return count === 1 ? header : `${header} ${count}`;
  });
  const labelColumn = unique.findIndex(header => /^(name|title|item|product|service)$/iu.test(header));
  const lines: string[] = [];
  for (const [index, row] of rows.slice(1).entries()) {
    const label = (labelColumn >= 0 ? row[labelColumn] : row.find(cell => cell.trim()))?.trim() || `Row ${index + 1}`;
    lines.push(heading(label, 3));
    unique.forEach((header, column) => {
      const value = row[column]?.replace(/\s+/gu, " ").trim();
      if (value) lines.push(`- ${header}: ${value}`);
    });
    if (index < rows.length - 2) lines.push("");
  }
  return lines.join("\n");
}

export function convertStructuredSource(contentType: StructuredContentType, bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PlatformError("SOURCE_ENCODING_INVALID", 400, "Use UTF-8 encoded content");
  }
  text = text.replace(/^\uFEFF/u, "");
  if (!text.trim()) throw invalid("The file is empty");
  const markdown = contentType === "application/json" ? jsonToMarkdown(text) : csvToMarkdown(text);
  const body = `<!-- source: ${contentType}; normalizer: ${STRUCTURED_SOURCE_RELEASE} -->\n\n${markdown}`;
  if (Buffer.byteLength(body, "utf8") > SOURCE_LIMITS.textBytes) throw new PlatformError("SOURCE_SIZE_INVALID", 413, "Converted content exceeds the knowledge limit");
  return body;
}
