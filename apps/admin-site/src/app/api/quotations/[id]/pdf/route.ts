import { NextResponse } from "next/server";
import { getAdminSession, fetchFromCore } from "@/lib/admin-auth";
import { buildQuotationPdf, quotationRecordToDraft } from "@/lib/quotation";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const res = await fetchFromCore(`/api/admin/quotations/${id}`);
  if (!res.ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const quotation = await res.json();

  const draft = quotationRecordToDraft(quotation);
  const pdf = buildQuotationPdf(draft);
  const filename = `${draft.preparedFor.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "quotation"}-quotation.pdf`;

  return new NextResponse(pdf, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
