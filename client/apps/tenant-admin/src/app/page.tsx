"use client";

import { RequireTenantAdminAuth } from "@/lib/auth";
import { AdminShell } from "@/components/admin-shell";

const metrics = [
  { label: "Client Workspaces", value: "18", helper: "4 pending onboarding" },
  { label: "Live Portals", value: "14", helper: "3 custom domains active" },
  { label: "Monthly Usage", value: "62k", helper: "Requests across tenants" },
  { label: "At Risk", value: "2", helper: "Require billing or limit review" },
];

export default function HomePage() {
  return (
    <RequireTenantAdminAuth>
      <AdminShell>
        <div className="space-y-8">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {metrics.map((metric) => (
              <section
                key={metric.label}
                className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5 backdrop-blur"
              >
                <div className="text-xs font-medium uppercase tracking-[0.18em] text-white/45">
                  {metric.label}
                </div>
                <div className="mt-3 text-4xl font-semibold text-white">{metric.value}</div>
                <div className="mt-2 text-sm text-white/55">{metric.helper}</div>
              </section>
            ))}
          </div>

          <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
            <section className="rounded-[32px] border border-white/10 bg-white/[0.04] p-6 backdrop-blur">
              <div className="text-lg font-semibold text-white">Workspace pipeline</div>
              <p className="mt-1 text-sm text-white/55">
                Provision new client environments, assign portal access, and monitor onboarding.
              </p>
              <div className="mt-6 space-y-3">
                {[
                  ["Brightstone Media", "Ready for branding setup"],
                  ["Summit Dental Group", "Waiting on domain verification"],
                  ["Oakline Properties", "Portal live, usage cap review needed"],
                ].map(([name, status]) => (
                  <div
                    key={name}
                    className="flex items-center justify-between rounded-2xl border border-white/8 bg-black/15 px-4 py-4"
                  >
                    <div>
                      <div className="font-medium text-white">{name}</div>
                      <div className="mt-1 text-sm text-white/50">{status}</div>
                    </div>
                    <div className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-xs text-cyan-200">
                      Active
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-[32px] border border-white/10 bg-white/[0.04] p-6 backdrop-blur">
              <div className="text-lg font-semibold text-white">Next actions</div>
              <ul className="mt-5 space-y-3 text-sm text-white/60">
                <li className="rounded-2xl border border-white/8 bg-black/15 px-4 py-4">
                  Connect real tenant auth to `kasitek-tenants`
                </li>
                <li className="rounded-2xl border border-white/8 bg-black/15 px-4 py-4">
                  Add client provisioning workflow and API key rotation
                </li>
                <li className="rounded-2xl border border-white/8 bg-black/15 px-4 py-4">
                  Surface workspace usage and billing status
                </li>
              </ul>
            </section>
          </div>
        </div>
      </AdminShell>
    </RequireTenantAdminAuth>
  );
}
