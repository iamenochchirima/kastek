import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { api, ApiError, message, organizationPath } from "./api";
import { ErrorMessage } from "./shell";

type MemberRole = "owner" | "admin" | "member";
type Member = {
  accountId: string;
  displayName: string;
  email: string;
  role: MemberRole;
  joinedAt: string;
};
type Invitation = {
  id: string;
  email: string;
  role: MemberRole;
  invitedByName: string;
  expiresAt: string;
  createdAt: string;
  expired: boolean;
};
type MembersResponse = {
  members: Member[];
  canManage: boolean;
  role: MemberRole;
  permissions: string[];
  grantableRoles: MemberRole[];
};
type InvitationsResponse = { invitations: Invitation[] };

const roleLabel = (role: MemberRole) => role === "owner" ? "Owner" : role === "admin" ? "Admin" : "Member";
const dateLabel = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
};
const initial = (value: string) => value.trim().slice(0, 1).toUpperCase() || "?";

export function MembersSettings({
  organizationId,
  currentAccountId,
}: {
  organizationId: string;
  currentAccountId: string;
}) {
  const { confirm } = useConfirmationDialog();
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [viewerRole, setViewerRole] = useState<MemberRole>("member");
  const [grantableRoles, setGrantableRoles] = useState<MemberRole[]>(["member"]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Member["role"]>("member");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState("");

  async function load() {
    setError("");
    try {
      const result = await api<MembersResponse>(`${organizationPath(organizationId)}/members`);
      setMembers(result.members);
      setCanManage(result.canManage);
      setViewerRole(result.role ?? "member");
      setGrantableRoles(result.grantableRoles ?? []);
      if (result.canManage) {
        const pending = await api<InvitationsResponse>(`${organizationPath(organizationId)}/invitations`);
        setInvitations(pending.invitations);
      } else {
        setInvitations([]);
      }
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let live = true;
    setLoading(true);
    setMembers([]);
    setInvitations([]);
    setCanManage(false);
    setViewerRole("member");
    setGrantableRoles(["member"]);
    void (async () => {
      try {
        const result = await api<MembersResponse>(`${organizationPath(organizationId)}/members`);
        if (!live) return;
        setMembers(result.members);
        setCanManage(result.canManage);
        setViewerRole(result.role ?? "member");
        setGrantableRoles(result.grantableRoles ?? []);
        if (result.canManage) {
          const pending = await api<InvitationsResponse>(`${organizationPath(organizationId)}/invitations`);
          if (live) setInvitations(pending.invitations);
        }
      } catch (cause) {
        if (live) setError(message(cause));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [organizationId]);

  const canManageMember = (member: Member) =>
    canManage && member.accountId !== currentAccountId && (viewerRole === "owner" || member.role === "member");

  async function invite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInviteBusy(true);
    setInviteError("");
    try {
      await api(`${organizationPath(organizationId)}/invitations`, {
        email: inviteEmail.trim(),
        role: inviteRole,
      });
      toast.success("Invitation sent");
      setInviteOpen(false);
      setInviteEmail("");
      setInviteRole("member");
      await load();
    } catch (cause) {
      setInviteError(
        cause instanceof ApiError && cause.code === "INVITATION_EMAIL_UNAVAILABLE"
          ? "Invitation email is not configured for this environment."
          : cause instanceof ApiError && cause.code === "INVITATION_EMAIL_FAILED"
            ? "Invitation saved, but the email could not be sent. Revoke it and try again."
            : message(cause),
      );
      await load();
    } finally {
      setInviteBusy(false);
    }
  }

  async function changeRole(member: Member, role: Member["role"]) {
    if (role === member.role) return;
    setBusyId(member.accountId);
    setError("");
    try {
      await api(`${organizationPath(organizationId)}/members/${encodeURIComponent(member.accountId)}`, { role }, "PATCH");
      toast.success("Role updated");
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusyId("");
    }
  }

  async function remove(member: Member) {
    const approved = await confirm({
      title: `Remove ${member.displayName}?`,
      description: "They will lose access to this workspace. Their account remains.",
      confirmLabel: "Remove",
      variant: "destructive",
    });
    if (!approved) return;
    setBusyId(member.accountId);
    setError("");
    try {
      await api(`${organizationPath(organizationId)}/members/${encodeURIComponent(member.accountId)}`, undefined, "DELETE");
      toast.success("Member removed");
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusyId("");
    }
  }

  async function revoke(invitation: Invitation) {
    const approved = await confirm({
      title: "Revoke invitation?",
      description: `${invitation.email} will no longer be able to join with this link.`,
      confirmLabel: "Revoke",
      variant: "destructive",
    });
    if (!approved) return;
    setBusyId(invitation.id);
    setError("");
    try {
      await api(`${organizationPath(organizationId)}/invitations/${encodeURIComponent(invitation.id)}`, undefined, "DELETE");
      toast.success("Invitation revoked");
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusyId("");
    }
  }

  if (loading) return <div className="space-y-4"><Skeleton className="h-7 w-40" /><Skeleton className="h-28 w-full" /></div>;

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">Members</h2>
          <p className="mt-1 text-sm text-muted-foreground">People with access to this workspace.</p>
        </div>
        {canManage ? <Button size="sm" onClick={() => { setInviteError(""); setInviteOpen(true); }}>Invite member</Button> : null}
      </div>
      <ErrorMessage value={error} />

      <ul className="mt-5 divide-y divide-border" aria-label="Workspace members">
        {members.map((member) => {
          const self = member.accountId === currentAccountId;
          const busy = busyId === member.accountId;
          return (
            <li key={member.accountId} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-medium text-secondary-foreground" aria-hidden="true">
                  {initial(member.displayName || member.email)}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{member.displayName || member.email}</p>
                  <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">Joined {dateLabel(member.joinedAt)}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">{roleLabel(member.role)}</span>
                {self ? <span className="text-xs text-muted-foreground">You</span> : null}
                {canManageMember(member) ? (
                  <>
                    <select
                      aria-label={`Role for ${member.displayName || member.email}`}
                      className="min-h-9 rounded-md border border-border bg-background px-2 text-sm"
                      value={member.role}
                      disabled={busy}
                      onChange={(event) => void changeRole(member, event.target.value as MemberRole)}
                    >
                      {grantableRoles.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}
                    </select>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void remove(member)}>Remove</Button>
                  </>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      {canManage ? (
        <section className="mt-6 border-t border-border pt-5">
          <h3 className="text-sm font-semibold text-foreground">Pending invitations</h3>
          {invitations.length ? (
            <ul className="mt-3 divide-y divide-border" aria-label="Pending invitations">
              {invitations.map((invitation) => (
                <li key={invitation.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm">{invitation.email}</p>
                    <p className="text-xs text-muted-foreground">
                      {roleLabel(invitation.role)} · {invitation.expired ? "Expired" : `Expires ${dateLabel(invitation.expiresAt)}`}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" disabled={busyId === invitation.id} onClick={() => void revoke(invitation)}>Revoke</Button>
                </li>
              ))}
            </ul>
          ) : <p className="mt-2 text-sm text-muted-foreground">No pending invitations</p>}
        </section>
      ) : null}

      <Dialog open={inviteOpen} onOpenChange={(open) => { if (!inviteBusy) { setInviteOpen(open); if (!open) setInviteError(""); } }}>
        <DialogContent>
          <form onSubmit={(event) => void invite(event)}>
            <DialogHeader>
              <DialogTitle>Invite member</DialogTitle>
              <DialogDescription>Send an invitation to join this workspace.</DialogDescription>
            </DialogHeader>
            <div className="mt-5 space-y-4">
              <label className="block space-y-2 text-sm">
                Email
                <Input type="email" required maxLength={254} value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} autoFocus />
              </label>
              <label className="block space-y-2 text-sm">
                Role
                <select className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value={inviteRole} onChange={(event) => setInviteRole(event.target.value as MemberRole)}>
                  {grantableRoles.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}
                </select>
              </label>
              {inviteError ? <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{inviteError}</p> : null}
            </div>
            <DialogFooter className="mt-6">
              <Button type="button" variant="outline" disabled={inviteBusy} onClick={() => setInviteOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={inviteBusy || !inviteEmail.trim()}>{inviteBusy ? "Sending…" : "Send invitation"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
