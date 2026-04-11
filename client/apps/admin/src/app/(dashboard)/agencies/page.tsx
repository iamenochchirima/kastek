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
  const data = res.ok ? await res.json() : { workspaces: [] };
  const workspaces: Workspace[] = data.workspaces ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text">Agencies ({workspaces.length})</h1>
        <Link
          href="/agencies/new"
          className="bg-primary hover:bg-primary-dark text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          + New Agency
        </Link>
      </div>

      <div className="bg-surface-raised rounded-xl border border-border overflow-hidden">
        {workspaces.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-text-faint text-sm">No agencies yet.</p>
            <Link href="/agencies/new" className="text-primary text-sm hover:underline mt-2 inline-block">
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
                    {new Date(ws.createdAt).toLocaleDateString()}
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
