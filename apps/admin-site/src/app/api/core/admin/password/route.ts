import { NextResponse } from "next/server";

import { proxyToCore } from "@/lib/admin-auth";

export async function PATCH(req: Request) {
  if (process.env.OPS_BACKEND_URL) return NextResponse.json(
    { error: "Password changes are managed by Labs identity", code: "identity_managed_password" },
    { status: 409 },
  );
  const res = await proxyToCore(req, "/api/admin/password", {
    method: "PATCH",
  });

  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
