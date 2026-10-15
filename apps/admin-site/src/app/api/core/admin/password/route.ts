import { NextResponse } from "next/server";

import { proxyToCore } from "@/lib/admin-auth";

export async function PATCH(req: Request) {
  const res = await proxyToCore(req, "/api/admin/password", {
    method: "PATCH",
  });

  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
