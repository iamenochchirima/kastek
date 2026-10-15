import { fetchFromTenants } from "@/lib/admin-auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import AgencyStatusToggle from "@/components/admin/agency-status-toggle";
import AgencyAddStaff from "@/components/admin/agency-add-staff";
import AgencyRemoveStaff from "@/components/admin/agency-remove-staff";
import AgencyAddApiKey from "@/components/admin/agency-add-api-key";
import AgencyRevokeApiKey from "@/components/admin/agency-revoke-api-key";
import AgencyDomainsManager from "@/components/admin/agency-domains-manager";
import { AdminMetric, AdminPageHeader } from "@/components/admin/page-header";
import { StatusBadge } from "@/components/admin/status-badge";
import { buttonClassName } from "@/components/ui/button";

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

  if (wsRes.status === 404) notFound();

  if (!wsRes.ok) {
    const errorData = await wsRes.json().catch(() => ({}));
    const message =
      typeof errorData?.error === "string"
        ? errorData.error
        : "Unable to load the agency right now.";

    return (
      <div className="admin-page max-w-5xl space-y-4">
        <Link
          href="/agencies"
          className="inline-block text-sm text-muted-foreground hover:text-foreground"
        >
          &larr; Back to Agencies
        </Link>
        <div className="v-card border-status-danger/25 bg-status-danger-soft p-[var(--density-card-padding)]">
          <h1 className="text-lg font-semibold text-foreground">Agency unavailable</h1>
          <p className="mt-2 text-sm text-status-danger">
            {message}
            {typeof errorData?.detail === "string" ? ` ${errorData.detail}` : null}
          </p>
        </div>
      </div>
    );
  }

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
    <div className="admin-page max-w-5xl">
      {/* Header */}
      <AdminPageHeader
        eyebrow="Platform / Agencies"
        title={workspace.displayName}
        description={`${workspace.slug}${workspace.domains.length > 0 ? ` · ${workspace.domains.join(", ")}` : ""}`}
        actions={<><AgencyStatusToggle workspaceId={id} currentStatus={workspace.status} /><Link href="/agencies" className={buttonClassName({ variant: "outline", size: "sm" })}>Back to agencies</Link></>}
      />

      {/* Stats row */}
      <div className="grid gap-3 sm:grid-cols-3">
        <AdminMetric label="Staff users" value={staff.length} />
        <AdminMetric label="Clients" value={clients.length} />
        <AdminMetric label="Active API keys" value={activeKeys.length} />
      </div>

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">Hosted portal domain</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            This system-managed domain is the tenant&apos;s immediate fallback access URL.
          </p>
        </div>
        <div className="v-card space-y-2 p-[var(--density-card-padding)] text-sm text-foreground">
          <p>
            <span className="text-muted-foreground">Hosted domain:</span>{" "}
            <span className="font-mono">{workspace.hostedDomain ?? "Not configured"}</span>
          </p>
          <p className="text-xs text-muted-foreground">
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
          <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">Staff users</h2>
          <AgencyAddStaff workspaceId={id} />
        </div>
        <div className="v-card overflow-hidden">
          {staff.length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-muted-foreground">No staff users yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="admin-table-head border-b border-line">
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Email</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Roles</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Added</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {staff.map((user) => (
                  <tr key={user.id}>
                    <td className="px-4 py-3 text-foreground">{user.email}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {(Array.isArray(user.roles) ? user.roles : []).map((r) => (
                          <span
                            key={r}
                            className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium capitalize text-primary"
                          >
                            {r}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge value={user.status} />
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
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
        <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">Clients</h2>
        <div className="v-card overflow-hidden">
          {clients.length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-muted-foreground">
              No clients yet — they are created by staff inside the tenant portal.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="admin-table-head border-b border-line">
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Name</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Slug</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">Users</th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {clients.map((c) => (
                  <tr key={c.id}>
                    <td className="px-4 py-3 font-medium text-foreground">{c.name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{c.slug}</td>
                    <td className="px-4 py-3">
                      <StatusBadge value={c.status} />
                    </td>
                    <td className="px-4 py-3 text-right text-foreground">{c.user_count}</td>
                    <td className="px-4 py-3 text-right text-xs text-muted-foreground">
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
          <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">API keys</h2>
          <AgencyAddApiKey workspaceId={id} />
        </div>

        <div className="v-card overflow-hidden">
          {activeKeys.length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-muted-foreground">No active API keys.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="admin-table-head border-b border-line">
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Label</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Prefix</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Scopes</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Created</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {activeKeys.map((key) => (
                  <tr key={key.id}>
                    <td className="px-4 py-3 text-foreground">{key.label}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{key.key_prefix}…</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {(Array.isArray(key.scopes) ? key.scopes : []).map((s) => (
                          <span
                            key={s}
                            className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                          >
                            {s}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
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
            <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
              {revokedKeys.length} revoked key{revokedKeys.length !== 1 ? "s" : ""}
            </summary>
            <div className="v-card mt-2 overflow-hidden opacity-60">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-border">
                  {revokedKeys.map((key) => (
                    <tr key={key.id}>
                      <td className="px-4 py-2 text-muted-foreground line-through">{key.label}</td>
                      <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{key.key_prefix}…</td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
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
