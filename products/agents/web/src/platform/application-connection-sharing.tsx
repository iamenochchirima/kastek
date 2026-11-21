import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { api, message } from "./api";
import { ErrorMessage } from "./shell";

type Sharing = { enabled: boolean; policyRevision: number };

export function ApplicationConnectionSharing({ path, connectionId }: { path: string; connectionId: string }) {
  const endpoint = `${path.replace(/\/(?:api-connections|remote-connections)$/, "/connections")}/${encodeURIComponent(connectionId)}/application-sharing`;
  const { confirm } = useConfirmationDialog();
  const [sharing, setSharing] = useState<Sharing | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    api<Sharing>(endpoint).then(value => { if (active) setSharing(value); }).catch(() => { if (active) setSharing(null); });
    return () => { active = false; };
  }, [endpoint]);
  async function change() {
    if (!sharing || busy) return;
    if (sharing.enabled && !await confirm({ title: "Remove application access?", description: "Active runs may stop.", confirmLabel: "Remove access", variant: "destructive" })) return;
    setBusy(true); setError("");
    try {
      const next = await api<Sharing>(endpoint, { enabled: !sharing.enabled, policyRevision: sharing.policyRevision }, "PUT");
      setSharing(next); toast.success("Access updated");
    } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }
  if (!sharing) return null;
  return <div className="space-y-2 border-t border-border pt-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-medium">Application access</p><p className="text-xs text-muted-foreground">{sharing.enabled ? "Read access enabled" : "Private"}</p></div><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void change()}>{busy ? "Saving…" : sharing.enabled ? "Remove access" : "Allow read access"}</Button></div><ErrorMessage value={error} /></div>;
}
