import { fetchFromTenants } from "@/lib/admin-auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import AgencyStatusToggle from "@/components/admin/agency-status-toggle";
import AgencyAddStaff from "@/components/admin/agency-add-staff";
import AgencyRemoveStaff from "@/components/admin/agency-remove-staff";
import AgencyAddApiKey from "@/components/admin/agency-add-api-key";
import AgencyRevokeApiKey from "@/components/admin/agency-revoke-api-key";
import AgencyDomainsManager from "@/components/admin/agency-domains-manager";

type StaffUser = {
  id: string;
  email: string;
  status: string;
  roles: string[];
  created_at: string;
};

type Client = {
  id: string;
  name: string;
  slug: string;
  status: string;
  user_count: number;
  created_at: string;
};

type ApiKey = {
  id: string;
  label: string;
  key_prefix: string;
  scopes: string[];
  revoked_at: string | null;
  created_at: string;
};

type Workspace = {
  id: string;
  slug: string;
  displayName: string;
  status: string;
  hostedDomain?: string | null;
  clientCount: number;
  domains: string[];
  domainRecords?: Array<{
    id: string;
    domain: string;
    is_primary: boolean;
    dns_status: string;
    verified_at: string | null;
    created_at: string;
    verification_message: string;
  }>;
  domainVerification?: {
    expectedTargetHost?: string | null;
  };
  createdAt: string;
};

export default async function AgencyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [wsRes, staffRes, clientsRes, keysRes] = await Promise.all([
    fetchFromTenants(`/api/admin/workspaces/${id}`),
    fetchFromTenants(`/api/admin/workspaces/${id}/staff`),
    fetchFromTenants(`/api/admin/workspaces/${id}/clients`),
    fetchFromTenants(`/api/admin/workspaces/${id}/api-keys`),
  ]);

  if (!wsRes.ok) notFound();

  const wsData = await wsRes.json();
  const workspace: Workspace = wsData.workspace ?? wsData;

  const staffData = staffRes.ok ? await staffRes.json() : { staff: [] };
  const staff: StaffUser[] = staffData.staff ?? [];

  const clientsData = clientsRes.ok ? await clientsRes.json() : { clients: [] };
  const clients: Client[] = clientsData.clients ?? [];

  const keysData = keysRes.ok ? await keysRes.json() : { apiKeys: [] };
  const apiKeys: ApiKey[] = keysData.apiKeys ?? [];
  const activeKeys = apiKeys.filter((k) => !k.revoked_at);
  const revokedKeys = apiKeys.filter((k) => k.revoked_at);

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <Link
          href="/agencies"
          className="text-sm text-text-muted hover:text-text mb-1 inline-block"
        >
          &larr; Back to Agencies
        </Link>
        <div className="flex items-start justify-between mt-1">
          <div>
            <h1 className="text-2xl font-bold text-text">{workspace.displayName}</h1>
            <p className="text-sm text-text-muted mt-0.5">
              <span className="font-mono">{workspace.slug}</span>
              {workspace.domains.length > 0 && (
                <> &middot; {workspace.domains.join(", ")}</>
              )}
            </p>
          </div>
          <AgencyStatusToggle
            workspaceId={id}
            currentStatus={workspace.status}
          />
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-surface-raised border border-border rounded-xl p-5">
          <p className="text-sm text-text-muted">Staff Users</p>
          <p className="text-3xl font-bold text-text mt-1">{staff.length}</p>
        </div>
        <div className="bg-surface-raised border border-border rounded-xl p-5">
          <p className="text-sm text-text-muted">Clients</p>
          <p className="text-3xl font-bold text-text mt-1">{clients.length}</p>
        </div>
        <div className="bg-surface-raised border border-border rounded-xl p-5">
          <p className="text-sm text-text-muted">Active API Keys</p>
          <p className="text-3xl font-bold text-text mt-1">{activeKeys.length}</p>
        </div>
      </div>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-text">Hosted Portal Domain</h2>
          <p className="text-sm text-text-muted mt-1">
            This system-managed domain is the tenant&apos;s immediate fallback access URL.
          </p>
        </div>
        <div className="rounded-xl border border-border bg-surface-raised p-5 text-sm text-text space-y-2">
          <p>
            <span className="text-text-muted">Hosted Domain:</span>{" "}
            <span className="font-mono">{workspace.hostedDomain ?? "Not configured"}</span>
          </p>
          <p className="text-text-faint text-xs">
            Keep the hosted domain active even after a custom domain is added so support and recovery access
            always have a stable fallback.
          </p>
        </div>
      </section>

      {/* Staff */}
      <AgencyDomainsManager
        workspaceId={id}
        workspaceSlug={workspace.slug}
        domains={workspace.domainRecords ?? []}
        expectedTargetHost={workspace.domainVerification?.expectedTargetHost ?? null}
        hostedDomain={workspace.hostedDomain ?? null}
      />

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text">Staff Users</h2>
          <AgencyAddStaff workspaceId={id} />
        </div>
        <div className="bg-surface-raised rounded-xl border border-border overflow-hidden">
          {staff.length === 0 ? (
            <p className="px-6 py-8 text-sm text-text-faint text-center">No staff users yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-4 py-3 text-left font-medium text-text-muted">Email</th>
                  <th className="px-4 py-3 text-left font-medium text-text-muted">Roles</th>
                  <th className="px-4 py-3 text-left font-medium text-text-muted">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-text-muted">Added</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {staff.map((user) => (
                  <tr key={user.id}>
                    <td className="px-4 py-3 text-text">{user.email}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {(Array.isArray(user.roles) ? user.roles : []).map((r) => (
                          <span
                            key={r}
                            className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium capitalize"
                          >
                            {r}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${
                          user.status === "active"
                            ? "bg-green-500/15 text-green-400"
                            : "bg-white/5 text-text-faint"
                        }`}
                      >
                        {user.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-text-faint text-xs">
                      {new Date(user.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <AgencyRemoveStaff workspaceId={id} userId={user.id} userEmail={user.email} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* Clients */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-text">Clients</h2>
        <div className="bg-surface-raised rounded-xl border border-border overflow-hidden">
          {clients.length === 0 ? (
            <p className="px-6 py-8 text-sm text-text-faint text-center">
              No clients yet — they are created by staff inside the tenant portal.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-4 py-3 text-left font-medium text-text-muted">Name</th>
                  <th className="px-4 py-3 text-left font-medium text-text-muted">Slug</th>
                  <th className="px-4 py-3 text-left font-medium text-text-muted">Status</th>
                  <th className="px-4 py-3 text-right font-medium text-text-muted">Users</th>
                  <th className="px-4 py-3 text-right font-medium text-text-muted">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {clients.map((c) => (
                  <tr key={c.id}>
                    <td className="px-4 py-3 font-medium text-text">{c.name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-text-muted">{c.slug}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${
                          c.status === "active"
                            ? "bg-green-500/15 text-green-400"
                            : "bg-white/5 text-text-faint"
                        }`}
                      >
                        {c.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-text">{c.user_count}</td>
                    <td className="px-4 py-3 text-right text-text-faint text-xs">
                      {new Date(c.created_at).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* API Keys */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text">API Keys</h2>
          <AgencyAddApiKey workspaceId={id} />
        </div>

        <div className="bg-surface-raised rounded-xl border border-border overflow-hidden">
          {activeKeys.length === 0 ? (
            <p className="px-6 py-8 text-sm text-text-faint text-center">No active API keys.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-4 py-3 text-left font-medium text-text-muted">Label</th>
                  <th className="px-4 py-3 text-left font-medium text-text-muted">Prefix</th>
                  <th className="px-4 py-3 text-left font-medium text-text-muted">Scopes</th>
                  <th className="px-4 py-3 text-left font-medium text-text-muted">Created</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {activeKeys.map((key) => (
                  <tr key={key.id}>
                    <td className="px-4 py-3 text-text">{key.label}</td>
                    <td className="px-4 py-3 font-mono text-xs text-text-muted">{key.key_prefix}…</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {(Array.isArray(key.scopes) ? key.scopes : []).map((s) => (
                          <span
                            key={s}
                            className="text-xs px-1.5 py-0.5 rounded bg-white/5 text-text-muted font-mono"
                          >
                            {s}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-text-faint text-xs">
                      {new Date(key.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <AgencyRevokeApiKey workspaceId={id} keyId={key.id} keyLabel={key.label} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {revokedKeys.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-text-faint hover:text-text">
              {revokedKeys.length} revoked key{revokedKeys.length !== 1 ? "s" : ""}
            </summary>
            <div className="mt-2 bg-surface-raised rounded-xl border border-border overflow-hidden opacity-60">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-border">
                  {revokedKeys.map((key) => (
                    <tr key={key.id}>
                      <td className="px-4 py-2 text-text-faint line-through">{key.label}</td>
                      <td className="px-4 py-2 font-mono text-xs text-text-faint">{key.key_prefix}…</td>
                      <td className="px-4 py-2 text-xs text-text-faint">
                        Revoked {key.revoked_at ? new Date(key.revoked_at).toLocaleDateString() : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </section>
    </div>
  );
}
