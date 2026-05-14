"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Crown,
  Mail,
  MoreHorizontal,
  Plus,
  Shield,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { apiUrl } from "@/lib/server-api";
import type { Org, OrgMember, OrgInvitation, OrgRole } from "@/lib/orgs";

const ROLE_LABELS: Record<OrgRole, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MEMBER: "Member",
};

const ROLE_ICONS: Record<OrgRole, React.ComponentType<{ className?: string }>> = {
  OWNER: Crown,
  ADMIN: Shield,
  MEMBER: UserRound,
};

function RoleBadge({ role }: { role: OrgRole }) {
  const Icon = ROLE_ICONS[role];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/50 px-2.5 py-1 text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
      <Icon className="h-3 w-3" />
      {ROLE_LABELS[role]}
    </span>
  );
}

export function TeamPageClient({
  org,
  orgs,
  members,
  invitations,
  currentUserId,
  currentRole,
}: {
  org: Org;
  orgs: Org[];
  members: OrgMember[];
  invitations: OrgInvitation[];
  currentUserId: string;
  currentRole: OrgRole;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"ADMIN" | "MEMBER">("MEMBER");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);

  const canManage = currentRole === "OWNER" || currentRole === "ADMIN";
  const pendingInvitations = invitations.filter((i) => !i.acceptedAt);

  function refresh() {
    startTransition(() => router.refresh());
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setInviteError(null);
    setInviteSuccess(null);

    const res = await fetch(apiUrl(`/api/orgs/${org.id}/invitations`), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
    });

    setInviting(false);

    if (res.ok) {
      setInviteEmail("");
      setInviteSuccess(`Invitation sent to ${inviteEmail.trim()}`);
      refresh();
    } else {
      const data = await res.json().catch(() => ({}));
      setInviteError(data.error ?? "Failed to send invitation");
    }
  }

  async function handleRevokeInvite(invId: string) {
    await fetch(apiUrl(`/api/orgs/${org.id}/invitations/${invId}`), {
      method: "DELETE",
      credentials: "include",
    });
    refresh();
  }

  async function handleRemoveMember(userId: string) {
    await fetch(apiUrl(`/api/orgs/${org.id}/members/${userId}`), {
      method: "DELETE",
      credentials: "include",
    });
    refresh();
  }

  async function handleChangeRole(userId: string, role: OrgRole) {
    await fetch(apiUrl(`/api/orgs/${org.id}/members/${userId}`), {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    refresh();
  }

  return (
    <div className="space-y-6 p-4 sm:space-y-8 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-3xl space-y-8">

        {/* Header */}
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
            Organisation
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            {org.name}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Manage members and invitations for your organisation.
          </p>
        </div>

        {/* Invite form */}
        {canManage ? (
          <section className="rounded-2xl border border-border bg-card p-5">
            <h2 className="mb-1 text-base font-semibold text-foreground">Invite a team member</h2>
            <p className="mb-5 text-sm text-muted-foreground">
              They'll receive an email with a link to join this organisation.
            </p>
            <form onSubmit={handleInvite} className="flex flex-col gap-3 sm:flex-row">
              <Input
                type="email"
                placeholder="colleague@example.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                className="flex-1"
                required
              />
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as "ADMIN" | "MEMBER")}
                className="rounded-md border border-border bg-secondary/40 px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="MEMBER">Member</option>
                <option value="ADMIN">Admin</option>
              </select>
              <Button type="submit" disabled={inviting} className="shrink-0 gap-2">
                <Plus className="h-4 w-4" />
                {inviting ? "Sending…" : "Send invite"}
              </Button>
            </form>
            {inviteError ? (
              <p className="mt-3 text-sm text-destructive">{inviteError}</p>
            ) : null}
            {inviteSuccess ? (
              <p className="mt-3 text-sm text-green-500">{inviteSuccess}</p>
            ) : null}
          </section>
        ) : null}

        {/* Members */}
        <section className="rounded-2xl border border-border bg-card">
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-base font-semibold text-foreground">
              Members
              <span className="ml-2 rounded-full border border-border bg-secondary/50 px-2 py-0.5 text-xs text-muted-foreground">
                {members.length}
              </span>
            </h2>
          </div>
          <div className="divide-y divide-border">
            {members.map((member) => {
              const isSelf = member.userId === currentUserId;
              const initials = (member.name ?? member.email ?? "?")
                .split(/\s+/)
                .slice(0, 2)
                .map((w) => w[0]?.toUpperCase() ?? "")
                .join("");
              const canEdit =
                canManage && !isSelf && member.role !== "OWNER";

              return (
                <div key={member.id} className="flex items-center gap-4 px-5 py-4">
                  <Avatar className="h-9 w-9 shrink-0 border border-border">
                    {member.image ? (
                      <AvatarImage src={member.image} alt={member.name ?? ""} />
                    ) : null}
                    <AvatarFallback className="bg-primary/15 text-xs font-semibold text-primary">
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {member.name ?? member.email ?? "Unknown"}
                      {isSelf ? (
                        <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>
                      ) : null}
                    </p>
                    {member.name ? (
                      <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                    ) : null}
                  </div>
                  <RoleBadge role={member.role} />
                  {canEdit ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {member.role !== "ADMIN" ? (
                          <DropdownMenuItem
                            onSelect={() => handleChangeRole(member.userId, "ADMIN")}
                          >
                            <Shield className="mr-2 h-4 w-4" />
                            Make Admin
                          </DropdownMenuItem>
                        ) : null}
                        {member.role !== "MEMBER" ? (
                          <DropdownMenuItem
                            onSelect={() => handleChangeRole(member.userId, "MEMBER")}
                          >
                            <UserRound className="mr-2 h-4 w-4" />
                            Make Member
                          </DropdownMenuItem>
                        ) : null}
                        {currentRole === "OWNER" && member.role !== "OWNER" ? (
                          <DropdownMenuItem
                            onSelect={() => handleChangeRole(member.userId, "OWNER")}
                          >
                            <Crown className="mr-2 h-4 w-4" />
                            Transfer ownership
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onSelect={() => handleRemoveMember(member.userId)}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Remove from org
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : isSelf && member.role !== "OWNER" ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => handleRemoveMember(member.userId)}
                    >
                      Leave
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>

        {/* Pending invitations */}
        {canManage && pendingInvitations.length > 0 ? (
          <section className="rounded-2xl border border-border bg-card">
            <div className="border-b border-border px-5 py-4">
              <h2 className="text-base font-semibold text-foreground">
                Pending invitations
                <span className="ml-2 rounded-full border border-border bg-secondary/50 px-2 py-0.5 text-xs text-muted-foreground">
                  {pendingInvitations.length}
                </span>
              </h2>
            </div>
            <div className="divide-y divide-border">
              {pendingInvitations.map((inv) => (
                <div key={inv.id} className="flex items-center gap-4 px-5 py-4">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-dashed border-border bg-secondary/40">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{inv.email}</p>
                    <p className="text-xs text-muted-foreground">
                      Invited as {ROLE_LABELS[inv.role]} ·{" "}
                      expires {new Date(inv.expiresAt).toLocaleDateString()}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => handleRevokeInvite(inv.id)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {/* Multiple orgs */}
        {orgs.length > 1 ? (
          <section className="rounded-2xl border border-border bg-card p-5">
            <h2 className="mb-3 text-base font-semibold text-foreground">Your organisations</h2>
            <div className="space-y-2">
              {orgs.map((o) => (
                <div
                  key={o.id}
                  className="flex items-center gap-3 rounded-xl border border-border bg-secondary/35 px-4 py-3"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-xs font-semibold text-primary">
                    {o.name[0]?.toUpperCase()}
                  </div>
                  <span className="flex-1 text-sm font-medium text-foreground">{o.name}</span>
                  {o.id === org.id ? (
                    <span className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-primary">
                      Active
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}

      </div>
    </div>
  );
}
