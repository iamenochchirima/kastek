type FontName = "F1" | "F2";

type PdfTextOp = {
  type: "text";
  x: number;
  y: number;
  text: string;
  size: number;
  font?: FontName;
  color?: string;
};

type PdfRectOp = {
  type: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  fill?: string;
  stroke?: string;
  lineWidth?: number;
};

type PdfLineOp = {
  type: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke?: string;
  lineWidth?: number;
};

export type PdfOp = PdfTextOp | PdfRectOp | PdfLineOp;

function escapePdfText(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function hexToRgb(hex?: string) {
  const value = (hex || "#111827").replace("#", "");
  const normalized = value.length === 3
    ? value.split("").map((char) => char + char).join("")
    : value;

  const red = parseInt(normalized.slice(0, 2), 16) / 255;
  const green = parseInt(normalized.slice(2, 4), 16) / 255;
  const blue = parseInt(normalized.slice(4, 6), 16) / 255;

  return `${red.toFixed(3)} ${green.toFixed(3)} ${blue.toFixed(3)}`;
}

function buildTextOp(op: PdfTextOp) {
  return [
    "BT",
    `${hexToRgb(op.color)} rg`,
    `/${op.font || "F1"} ${op.size} Tf`,
    `1 0 0 1 ${op.x} ${op.y} Tm`,
    `(${escapePdfText(op.text)}) Tj`,
    "ET",
  ].join("\n");
}

function buildRectOp(op: PdfRectOp) {
  const parts = [];
  if (op.lineWidth) parts.push(`${op.lineWidth} w`);
  if (op.fill) parts.push(`${hexToRgb(op.fill)} rg`);
  if (op.stroke) parts.push(`${hexToRgb(op.stroke)} RG`);
  parts.push(`${op.x} ${op.y} ${op.width} ${op.height} re`);

  if (op.fill && op.stroke) parts.push("B");
  else if (op.fill) parts.push("f");
  else parts.push("S");

  return parts.join("\n");
}

function buildLineOp(op: PdfLineOp) {
  return [
    `${op.lineWidth || 1} w`,
    `${hexToRgb(op.stroke)} RG`,
    `${op.x1} ${op.y1} m`,
    `${op.x2} ${op.y2} l`,
    "S",
  ].join("\n");
}

function buildOp(op: PdfOp) {
  if (op.type === "text") return buildTextOp(op);
  if (op.type === "rect") return buildRectOp(op);
  return buildLineOp(op);
}

export function wrapText(text: string, maxWidth: number, fontSize: number) {
  const estimatedChars = Math.max(10, Math.floor(maxWidth / (fontSize * 0.52)));
  if (text.length <= estimatedChars) return [text];

  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= estimatedChars) {
      current = next;
      continue;
    }

    if (current) lines.push(current);
    current = word;
  }

  if (current) lines.push(current);
  return lines;
}

export function buildPdfFromOps(pages: PdfOp[][]) {
  const objects: string[] = [];
  const pageObjectNumbers = pages.map((_, index) => 3 + index * 2);
  const fontRegularObjectNumber = 3 + pages.length * 2;
  const fontBoldObjectNumber = fontRegularObjectNumber + 1;

  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${pageObjectNumbers.map((n) => `${n} 0 R`).join(" ")}] /Count ${pages.length} >>`;

  pages.forEach((ops, index) => {
    const pageObjectNumber = 3 + index * 2;
    const contentObjectNumber = pageObjectNumber + 1;
    const streamBody = ops.map(buildOp).join("\n");

    objects[pageObjectNumber - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
      `/Resources << /Font << /F1 ${fontRegularObjectNumber} 0 R /F2 ${fontBoldObjectNumber} 0 R >> >> ` +
      `/Contents ${contentObjectNumber} 0 R >>`;

    objects[contentObjectNumber - 1] =
      `<< /Length ${Buffer.byteLength(streamBody, "utf8")} >>\nstream\n${streamBody}\nendstream`;
  });

  objects[fontRegularObjectNumber - 1] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objects[fontBoldObjectNumber - 1] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";

  let pdf = "%PDF-1.4\n";
  const offsets = [0];

  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";

  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${offsets[index].toString().padStart(10, "0")} 00000 n \n`;
  }

  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(pdf, "utf8");
}
