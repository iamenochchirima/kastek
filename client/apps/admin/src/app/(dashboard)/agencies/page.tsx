import { fetchFromTenants } from "@/lib/admin-auth";
import Link from "next/link";
import { Plus } from "lucide-react";
import { AdminPageHeader } from "@/components/admin/page-header";
import { StatusBadge } from "@/components/admin/status-badge";
import { buttonClassName } from "@/components/ui/button";

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
    <div className="admin-page">
      <AdminPageHeader title="Agencies" description={`${workspaces.length} tenant workspace${workspaces.length === 1 ? "" : "s"} provisioned on the platform.`} actions={<Link href="/agencies/new" className={buttonClassName()}><Plus className="size-4" />New agency</Link>} />

      <div className="admin-table-wrap">
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
          <table className="w-full min-w-[700px] text-sm">
            <thead>
              <tr className="admin-table-head border-b border-border">
                <th className="px-4 py-3 text-left">Name</th>
                <th className="px-4 py-3 text-left">Slug</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-right">Clients</th>
                <th className="px-4 py-3 text-right">Created</th>
                <th className="px-4 py-3 text-right"></th>
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
                    <StatusBadge value={ws.status} />
                  </td>
                  <td className="px-4 py-3 text-right text-text">{ws.clientCount}</td>
                  <td className="px-4 py-3 text-right text-text-faint">
                    {ws.createdAt ? new Date(ws.createdAt).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/agencies/${ws.id}`}
                      className={buttonClassName({ variant: "secondary", size: "sm" })}
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
