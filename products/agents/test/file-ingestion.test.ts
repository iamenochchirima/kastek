import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { extractKnowledgeFile, MAX_KNOWLEDGE_FILE_BYTES } from "../src/knowledge/file-ingestion";

function samplePdf(): Buffer {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    "5 0 obj\n<< /Length 44 >>\nstream\nBT /F1 18 Tf 72 720 Td (Hello KasiTek) Tj ET\nendstream\nendobj\n",
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(output));
    output += object;
  }
  const xrefOffset = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output);
}

function sampleDocx(): Buffer {
  return Buffer.from("UEsDBBQAAAAIAC6mE13MVIwQ4AAAAJwBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2Qy07DMBBFf8XyFsUTukAIJekCyhJYlA+w7Eli4Zc8bil/z6QtXaDC0r6PM7rd+hC82GMhl2Ivb1UrBUaTrItTL9+3z829XA/d9isjCbZG6uVca34AIDNj0KRSxsjKmErQlZ9lgqzNh54QVm17BybFirE2demQQ/eEo975KjYH/j5hC3qS4vFkXFi91Dl7Z3RlHfbR/qI0Z4Li5NFDs8t0wwYJVwmL8jfgnHvlHYqzKN50qS86sAs+U7Fgk9kFTqr/a67cmcbRGbzkl7ZckkEiHjh4dVGCdvHnfjjOPXwDUEsDBBQAAAAIAC6mE102V97cogAAABgBAAALAAAAX3JlbHMvLnJlbHONzzsOwjAMBuCrRN6pCwNCqGkXhNQVlQNEiZtGNA8l4XV7MjBQxMBo+/dnuekedmY3isl4x2Fd1cDISa+M0xzOw3G1g65tTjSLXBJpMiGxsuIShynnsEdMciIrUuUDuTIZfbQilzJqDEJehCbc1PUW46cBS5P1ikPs1RrY8Az0j+3H0Ug6eHm15PKPE1+JIouoKXO4+6hQvdtVYQHbBhcvti9QSwMEFAAAAAgALqYTXYprgWigAAAA0wAAABEAAAB3b3JkL2RvY3VtZW50LnhtbEWOMQ/CIBCF/wpht1QHY5pSB41xc9HEFeFsm8AdAbT23wt1cPleXi735bX7j7PsDSGOhJKvq5ozQE1mxF7y2/W02nEWk0KjLCFIPkPk+66dGkP65QATywKMzST5kJJvhIh6AKdiRR4w354UnEq5hl5MFIwPpCHG7HdWbOp6K5wakRflg8xc0heEgtSdwVpix8vh3orSC8NCv/D3I/57ui9QSwECFAMUAAAACAAuphNdzFSMEOAAAACcAQAAEwAAAAAAAAAAAAAAgAEAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAxQAAAAIAC6mE102V97cogAAABgBAAALAAAAAAAAAAAAAACAAREBAABfcmVscy8ucmVsc1BLAQIUAxQAAAAIAC6mE12Ka4FooAAAANMAAAARAAAAAAAAAAAAAACAAdwBAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAAAwADALkAAACrAgAAAAA=", "base64");
}

describe("knowledge file extraction", () => {
  it("extracts text and markdown without changing their content", async () => {
    await expect(extractKnowledgeFile({ filename: "facts.md", contentType: "text/markdown", bytes: Buffer.from("# Facts\n\nKasiTek helps businesses.") })).resolves.toMatchObject({ format: "markdown", text: "# Facts\n\nKasiTek helps businesses." });
    await expect(extractKnowledgeFile({ filename: "facts.txt", bytes: Buffer.from("Plain text\r\nsecond line") })).resolves.toMatchObject({ format: "text", text: "Plain text\nsecond line" });
  });

  it("turns CSV rows into searchable labeled text", async () => {
    const result = await extractKnowledgeFile({ filename: "services.csv", contentType: "text/csv", bytes: Buffer.from('Name,Price,Notes\n"WhatsApp bot",150,"Answers, books, and captures leads"\n') });
    expect(result.format).toBe("csv");
    expect(result.text).toContain("Columns: Name | Price | Notes");
    expect(result.text).toContain("Name: WhatsApp bot | Price: 150 | Notes: Answers, books, and captures leads");
    expect(result.metadata).toMatchObject({ rows: 1, columns: 3 });
  });

  it("extracts PDF text and reports pages", async () => {
    const result = await extractKnowledgeFile({ filename: "guide.pdf", contentType: "application/pdf", bytes: samplePdf() });
    expect(result.format).toBe("pdf");
    expect(result.text).toContain("Hello KasiTek");
    expect(result.metadata).toMatchObject({ pages: 1 });
  });

  it("extracts DOCX paragraph text", async () => {
    const result = await extractKnowledgeFile({ filename: "guide.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: sampleDocx() });
    expect(result.format).toBe("docx");
    expect(result.text).toContain("Hello DOCX");
  });

  it("extracts workbook sheets as labeled CSV sections", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Service", "Price"], ["Chatbot", "R1500"]]), "Services");
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const result = await extractKnowledgeFile({ filename: "pricing.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes });
    expect(result.format).toBe("xlsx");
    expect(result.text).toContain("Sheet: Services");
    expect(result.text).toContain("Service,Price\nChatbot,R1500");
    expect(result.metadata).toMatchObject({ sheets: 1, rows: 2 });
  });

  it("rejects unsupported, malformed, binary, and oversized files", async () => {
    await expect(extractKnowledgeFile({ filename: "notes.exe", bytes: Buffer.from("MZ") })).rejects.toThrow("Unsupported file type");
    await expect(extractKnowledgeFile({ filename: "guide.pdf", bytes: Buffer.from("not a pdf") })).rejects.toThrow("valid PDF signature");
    await expect(extractKnowledgeFile({ filename: "guide.docx", bytes: Buffer.from("not a zip") })).rejects.toThrow("valid Office document signature");
    await expect(extractKnowledgeFile({ filename: "data.csv", bytes: Buffer.from([0x61, 0x00, 0x62]) })).rejects.toThrow("binary data");
    await expect(extractKnowledgeFile({ filename: "large.txt", bytes: Buffer.alloc(MAX_KNOWLEDGE_FILE_BYTES + 1) })).rejects.toThrow("20 MB limit");
  });
});
