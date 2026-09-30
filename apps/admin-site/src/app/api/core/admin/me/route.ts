import { getAdminSession } from "@/lib/admin-auth";
import { NextResponse } from "next/server";

export async function GET() {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(admin);
}
