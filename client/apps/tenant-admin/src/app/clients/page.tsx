"use client";

import { AdminShell } from "@/components/admin-shell";
import { RequireTenantAdminAuth } from "@/lib/auth";

export default function ClientsPage() {
  return (
    <RequireTenantAdminAuth>
      <AdminShell>
        <section className="rounded-[32px] border border-white/10 bg-white/[0.04] p-6 backdrop-blur">
          <h1 className="text-2xl font-semibold text-white">Clients</h1>
          <p className="mt-2 text-sm text-white/55">
            Scaffold screen for tenant-side client management, provisioning, and workspace access.
          </p>
        </section>
      </AdminShell>
    </RequireTenantAdminAuth>
  );
}
