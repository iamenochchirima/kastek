import { fetchFromTenants } from "@/lib/admin-auth";
import Link from "next/link";

interface Workspace {
  id: string;
  slug: string;
  displayName: string;
  status: string;
  clientCount: number;
  createdAt: string;
}

export default async function AgenciesPage() {
  const res = await fetchFromTenants("/api/admin/workspaces");
  const data = await res.json().catch(() => ({}));
  const loadError =
    !res.ok && typeof data?.error === "string"
      ? data.error
      : !res.ok
        ? "Unable to load agencies right now."
        : null;

  const workspaces: Workspace[] = Array.isArray(data?.workspaces)
    ? data.workspaces.map(
        (workspace: {
          id: string;
          slug: string;
          displayName?: string;
          display_name?: string;
          status: string;
          clientCount?: number;
          client_count?: number;
          createdAt?: string;
          created_at?: string;
        }) => ({
          id: workspace.id,
          slug: workspace.slug,
          displayName: workspace.displayName ?? workspace.display_name ?? workspace.slug,
          status: workspace.status,
          clientCount: workspace.clientCount ?? workspace.client_count ?? 0,
          createdAt: workspace.createdAt ?? workspace.created_at ?? "",
        })
      )
    : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text">Agencies ({workspaces.length})</h1>
          <p className="text-sm text-text-muted mt-1">
            Tenant workspaces provisioned on the platform.
          </p>
        </div>
        <Link
          href="/agencies/new"
          className="bg-primary hover:bg-primary-dark text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          + New Agency
        </Link>
      </div>

      <div className="bg-surface-raised rounded-xl border border-border overflow-hidden">
        {loadError ? (
          <div className="border-b border-border bg-danger/10 px-4 py-3 text-sm text-danger">
            {loadError}
            {typeof data?.detail === "string" ? ` ${data.detail}` : null}
          </div>
        ) : null}
        {workspaces.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-text-faint text-sm">
              {loadError ? "The agencies list is temporarily unavailable." : "No agencies yet."}
            </p>
            <Link
              href="/agencies/new"
              className="text-primary text-sm hover:underline mt-2 inline-block"
            >
              Create your first agency workspace
            </Link>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="px-4 py-3 text-left font-medium text-text-muted">Name</th>
                <th className="px-4 py-3 text-left font-medium text-text-muted">Slug</th>
                <th className="px-4 py-3 text-left font-medium text-text-muted">Status</th>
                <th className="px-4 py-3 text-right font-medium text-text-muted">Clients</th>
                <th className="px-4 py-3 text-right font-medium text-text-muted">Created</th>
                <th className="px-4 py-3 text-right font-medium text-text-muted"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {workspaces.map((ws) => (
                <tr key={ws.id} className="hover:bg-surface-overlay transition-colors">
                  <td className="px-4 py-3">
                    <p className="font-medium text-text">{ws.displayName}</p>
                  </td>
                  <td className="px-4 py-3 text-text-muted font-mono text-xs">{ws.slug}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`text-xs font-medium px-2.5 py-1 rounded-full capitalize ${
                        ws.status === "active"
                          ? "bg-green-500/15 text-green-400"
                          : "bg-white/5 text-text-faint"
                      }`}
                    >
                      {ws.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-text">{ws.clientCount}</td>
                  <td className="px-4 py-3 text-right text-text-faint">
                    {ws.createdAt ? new Date(ws.createdAt).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/agencies/${ws.id}`}
                      className="inline-flex items-center rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text hover:bg-surface-overlay transition-colors"
                    >
                      Manage
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
