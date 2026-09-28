import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import * as XLSX from "xlsx";

export const MAX_KNOWLEDGE_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_KNOWLEDGE_EXTRACTED_CHARACTERS = 200_000;

export type KnowledgeFileFormat = "text" | "markdown" | "csv" | "pdf" | "docx" | "xlsx";

export interface KnowledgeFileInput {
  filename: string;
  contentType?: string;
  bytes: Buffer;
}

export interface ExtractedKnowledgeFile {
  filename: string;
  format: KnowledgeFileFormat;
  contentType: string;
  bytes: number;
  text: string;
  metadata: Record<string, unknown>;
}

const extensionFormats: Record<string, KnowledgeFileFormat> = {
  txt: "text",
  text: "text",
  md: "markdown",
  markdown: "markdown",
  csv: "csv",
  pdf: "pdf",
  docx: "docx",
  xlsx: "xlsx",
  xls: "xlsx",
};

const mimeFormats: Record<string, KnowledgeFileFormat> = {
  "text/plain": "text",
  "text/markdown": "markdown",
  "text/csv": "csv",
  "application/csv": "csv",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xlsx",
};

function extension(filename: string): string {
  return filename.trim().toLowerCase().split(".").pop() ?? "";
}

function formatFor(input: KnowledgeFileInput): KnowledgeFileFormat | undefined {
  return extensionFormats[extension(input.filename)] ?? mimeFormats[(input.contentType ?? "").split(";", 1)[0]!.trim().toLowerCase()];
}

function hasPrefix(bytes: Buffer, prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function assertFileSignature(format: KnowledgeFileFormat, bytes: Buffer): void {
  if (format === "pdf" && !bytes.subarray(0, 5).toString("ascii").startsWith("%PDF-")) {
    throw new Error("The file does not contain a valid PDF signature");
  }
  if ((format === "docx" || format === "xlsx") && !hasPrefix(bytes, [0x50, 0x4b])) {
    const legacyExcel = format === "xlsx" && hasPrefix(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    if (!legacyExcel) throw new Error("The file does not contain a valid Office document signature");
  }
  if ((format === "text" || format === "markdown" || format === "csv") && bytes.includes(0)) {
    throw new Error("The text file contains binary data");
  }
}

function normalizeText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if (character === "\n" && !quoted) {
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error("The CSV file contains an unterminated quoted field");
  if (cell.length || row.length) {
    row.push(cell.trim());
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((value) => value.length > 0));
}

function csvToKnowledgeText(input: string): { text: string; rows: number; columns: number } {
  const rows = parseCsvRows(input);
  if (!rows.length) return { text: "", rows: 0, columns: 0 };
  const columns = Math.max(...rows.map((row) => row.length));
  const headers = rows[0]!.map((value, index) => value || `Column ${index + 1}`);
  const lines = [
    `Columns: ${headers.join(" | ")}`,
    ...rows.slice(1).map((row) => row.map((value, index) => `${headers[index] ?? `Column ${index + 1}`}: ${value}`).join(" | ")),
  ];
  return { text: lines.join("\n"), rows: Math.max(0, rows.length - 1), columns };
}

async function extractPdf(bytes: Buffer): Promise<{ text: string; pages: number }> {
  const parser = new PDFParse({ data: bytes, isEvalSupported: false, useWorkerFetch: false });
  try {
    const result = await parser.getText();
    return { text: result.text, pages: result.total };
  } finally {
    await parser.destroy();
  }
}

async function extractDocx(bytes: Buffer): Promise<{ text: string; warnings: number }> {
  const result = await mammoth.extractRawText({ buffer: bytes });
  return { text: result.value, warnings: result.messages.length };
}

function extractWorkbook(bytes: Buffer): { text: string; sheets: number; rows: number } {
  const workbook = XLSX.read(bytes, { type: "buffer", cellDates: true, cellText: true, dense: true });
  const sections: string[] = [];
  let rows = 0;
  for (const sheetName of workbook.SheetNames.slice(0, 100)) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false }).trim();
    if (!csv) continue;
    rows += csv.split("\n").length;
    sections.push(`Sheet: ${sheetName}\n${csv}`);
  }
  return { text: sections.join("\n\n"), sheets: sections.length, rows };
}

export async function extractKnowledgeFile(input: KnowledgeFileInput): Promise<ExtractedKnowledgeFile> {
  const filename = input.filename.trim().slice(0, 240);
  if (!filename) throw new Error("A file name is required");
  if (!input.bytes.length) throw new Error("The file is empty");
  if (input.bytes.length > MAX_KNOWLEDGE_FILE_BYTES) throw new Error("The file exceeds the 20 MB limit");
  const format = formatFor(input);
  if (!format) throw new Error("Unsupported file type. Use TXT, Markdown, CSV, PDF, DOCX, or Excel files.");
  assertFileSignature(format, input.bytes);
  const contentType = (input.contentType ?? "application/octet-stream").split(";", 1)[0]!.trim().toLowerCase();
  let text = "";
  const metadata: Record<string, unknown> = {};
  if (format === "text" || format === "markdown") {
    text = new TextDecoder().decode(input.bytes);
  } else if (format === "csv") {
    const parsed = csvToKnowledgeText(new TextDecoder().decode(input.bytes));
    text = parsed.text;
    metadata.rows = parsed.rows;
    metadata.columns = parsed.columns;
  } else if (format === "pdf") {
    const parsed = await extractPdf(input.bytes);
    text = parsed.text;
    metadata.pages = parsed.pages;
  } else if (format === "docx") {
    const parsed = await extractDocx(input.bytes);
    text = parsed.text;
    metadata.warnings = parsed.warnings;
  } else {
    const parsed = extractWorkbook(input.bytes);
    text = parsed.text;
    metadata.sheets = parsed.sheets;
    metadata.rows = parsed.rows;
  }
  text = normalizeText(text);
  if (!text) throw new Error("No readable text was found in the file. Scanned PDFs may need OCR.");
  if (text.length > MAX_KNOWLEDGE_EXTRACTED_CHARACTERS) throw new Error("The extracted text exceeds the 200,000 character limit");
  return { filename, format, contentType, bytes: input.bytes.length, text, metadata };
}
