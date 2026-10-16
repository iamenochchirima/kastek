import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json(
    {
      error: "Lead-based quotation PDFs have been replaced by standalone quotations. Create a quotation first.",
    },
    { status: 410 }
  );
}
