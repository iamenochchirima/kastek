"use client";

import { useMemo, useState } from "react";
import {
  getListTenantClientsQueryKey,
  getListTenantClientUsersQueryKey,
  useCreateTenantClient,
  useInviteTenantClientUser,
  useListTenantClients,
  useListTenantClientUsers,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Building2, Copy, MailPlus, Plus, Users } from "lucide-react";
import { ProtectedRoute } from "@/lib/auth";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CLIENT_ADMIN_ROLES } from "@/lib/tenant-access";

const createClientSchema = z.object({
  name: z.string().min(2, "Client name is required"),
  slug: z.string().optional(),
  external_ref: z.string().optional(),
});

const inviteUserSchema = z.object({
  email: z.string().email("Valid email is required"),
  name: z.string().optional(),
  role: z.string().min(1, "Role is required"),
});

export default function ClientsScreen() {
  const queryClient = useQueryClient();
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [isClientDialogOpen, setIsClientDialogOpen] = useState(false);
  const [isInviteDialogOpen, setIsInviteDialogOpen] = useState(false);
  const [latestInviteLink, setLatestInviteLink] = useState<string | null>(null);

  const { data: clients, isLoading: isLoadingClients } = useListTenantClients();
  const activeClientId = selectedClientId || clients?.[0]?.id || "";
  const { data: clientUsers, isLoading: isLoadingUsers } = useListTenantClientUsers(activeClientId, {
    enabled: !!activeClientId,
  });

  const createClient = useCreateTenantClient();
  const inviteClientUser = useInviteTenantClientUser();

  const createClientForm = useForm<z.infer<typeof createClientSchema>>({
    resolver: zodResolver(createClientSchema),
    defaultValues: {
      name: "",
      slug: "",
      external_ref: "",
    },
  });

  const inviteUserForm = useForm<z.infer<typeof inviteUserSchema>>({
    resolver: zodResolver(inviteUserSchema),
    defaultValues: {
      email: "",
      name: "",
      role: "member",
    },
  });

  const selectedClient = useMemo(
    () => clients?.find((client) => client.id === activeClientId) ?? null,
    [activeClientId, clients],
  );

  const onCreateClient = (values: z.infer<typeof createClientSchema>) => {
    createClient.mutate(
      {
        name: values.name,
        slug: values.slug,
        external_ref: values.external_ref,
      },
      {
        onSuccess: (client) => {
          void queryClient.invalidateQueries({ queryKey: getListTenantClientsQueryKey() });
          setSelectedClientId(client.id);
          setIsClientDialogOpen(false);
          createClientForm.reset();
      },
      onError: (error) => {
        createClientForm.setError("root", {
          message: error instanceof Error ? error.message : "Unable to create client",
        });
      },
      },
    );
  };

  const onInviteUser = (values: z.infer<typeof inviteUserSchema>) => {
    if (!activeClientId) {
      inviteUserForm.setError("root", { message: "Select a client first" });
      return;
    }

    inviteClientUser.mutate(
      {
        tenantClientId: activeClientId,
        email: values.email,
        name: values.name,
        role: values.role,
      },
      {
        onSuccess: (invite) => {
          void queryClient.invalidateQueries({
            queryKey: getListTenantClientUsersQueryKey(activeClientId),
          });
          const fallbackLink =
            typeof window !== "undefined"
              ? `${window.location.origin}/activate?token=${invite.token}`
              : null;
          setLatestInviteLink(invite.activationUrl ?? fallbackLink);
          setIsInviteDialogOpen(false);
          inviteUserForm.reset({ email: "", name: "", role: "member" });
        },
        onError: (error) => {
          inviteUserForm.setError("root", {
            message: error instanceof Error ? error.message : "Unable to invite client user",
          });
        },
      },
    );
  };

  const copyInviteToken = async () => {
    if (!latestInviteLink || typeof navigator === "undefined") {
      return;
    }

    await navigator.clipboard.writeText(latestInviteLink);
  };

  return (
    <ProtectedRoute allowedRoles={CLIENT_ADMIN_ROLES}>
      <Layout>
        <div className="space-y-8 p-8 animate-in fade-in duration-500">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Clients</h1>
              <p className="mt-1 text-muted-foreground">
                Manage the companies under this tenant workspace and invite their users into the platform.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Dialog open={isClientDialogOpen} onOpenChange={setIsClientDialogOpen}>
                <DialogTrigger asChild>
                  <Button>
                    <Plus className="mr-2 h-4 w-4" />
                    Add Client
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Create Tenant Client</DialogTitle>
                    <DialogDescription>
                      Add a new client account under this tenant workspace.
                    </DialogDescription>
                  </DialogHeader>
                  <Form {...createClientForm}>
                    <form onSubmit={createClientForm.handleSubmit(onCreateClient)} className="space-y-4">
                      <FormField
                        control={createClientForm.control}
                        name="name"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Client Name</FormLabel>
                            <FormControl>
                              <Input placeholder="Acme Dental" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={createClientForm.control}
                        name="slug"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Slug</FormLabel>
                            <FormControl>
                              <Input placeholder="acme-dental" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={createClientForm.control}
                        name="external_ref"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>External Ref</FormLabel>
                            <FormControl>
                              <Input placeholder="CRM-123" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      {createClientForm.formState.errors.root && (
                        <p className="text-sm text-destructive">
                          {createClientForm.formState.errors.root.message}
                        </p>
                      )}
                      <div className="flex justify-end">
                        <Button type="submit" disabled={createClient.isPending}>
                          {createClient.isPending ? "Creating..." : "Create Client"}
                        </Button>
                      </div>
                    </form>
                  </Form>
                </DialogContent>
              </Dialog>

              <Dialog open={isInviteDialogOpen} onOpenChange={setIsInviteDialogOpen}>
                <DialogTrigger asChild>
                  <Button variant="outline" disabled={!activeClientId}>
                    <MailPlus className="mr-2 h-4 w-4" />
                    Invite User
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Invite Client User</DialogTitle>
                    <DialogDescription>
                      Invite a user into {selectedClient?.name ?? "this client account"}.
                    </DialogDescription>
                  </DialogHeader>
                  <Form {...inviteUserForm}>
                    <form onSubmit={inviteUserForm.handleSubmit(onInviteUser)} className="space-y-4">
                      <FormField
                        control={inviteUserForm.control}
                        name="email"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Email</FormLabel>
                            <FormControl>
                              <Input placeholder="owner@client.com" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={inviteUserForm.control}
                        name="name"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Name</FormLabel>
                            <FormControl>
                              <Input placeholder="Jane Doe" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={inviteUserForm.control}
                        name="role"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Role</FormLabel>
                            <Select onValueChange={field.onChange} defaultValue={field.value}>
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue placeholder="Select role" />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="member">Member</SelectItem>
                                <SelectItem value="owner">Owner</SelectItem>
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      {inviteUserForm.formState.errors.root && (
                        <p className="text-sm text-destructive">
                          {inviteUserForm.formState.errors.root.message}
                        </p>
                      )}
                      <div className="flex justify-end">
                        <Button type="submit" disabled={inviteClientUser.isPending}>
                          {inviteClientUser.isPending ? "Sending..." : "Send Invite"}
                        </Button>
                      </div>
                    </form>
                  </Form>
                </DialogContent>
              </Dialog>
            </div>
          </div>

          {latestInviteLink && (
            <Card className="border-primary/20 bg-primary/5">
              <CardHeader>
                <CardTitle className="text-base">Latest Invite Link</CardTitle>
                <CardDescription>
                  Copy this activation link into the client onboarding flow until email delivery is wired.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 lg:flex-row lg:items-center">
                <code className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm">
                  {latestInviteLink}
                </code>
                <Button variant="secondary" onClick={() => void copyInviteToken()}>
                  <Copy className="mr-2 h-4 w-4" />
                  Copy Link
                </Button>
              </CardContent>
            </Card>
          )}

          <div className="grid gap-8 xl:grid-cols-[1.1fr,0.9fr]">
            <Card>
              <CardHeader>
                <CardTitle>Tenant Clients</CardTitle>
                <CardDescription>Organizations currently operating inside this tenant workspace.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {isLoadingClients ? (
                  Array.from({ length: 4 }).map((_, index) => (
                    <Skeleton key={index} className="h-24 w-full rounded-xl" />
                  ))
                ) : clients?.length ? (
                  clients.map((client) => {
                    const isActive = activeClientId === client.id;

                    return (
                      <button
                        key={client.id}
                        type="button"
                        onClick={() => setSelectedClientId(client.id)}
                        className={`w-full rounded-xl border p-4 text-left transition-colors ${
                          isActive
                            ? "border-primary bg-primary/5"
                            : "border-border bg-card hover:border-primary/30 hover:bg-muted/40"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <Building2 className="h-4 w-4 text-primary" />
                              <span className="truncate font-semibold">{client.name}</span>
                            </div>
                            <p className="mt-1 text-sm text-muted-foreground">{client.slug}</p>
                            {client.external_ref && (
                              <p className="mt-1 text-xs text-muted-foreground">
                                External ref: {client.external_ref}
                              </p>
                            )}
                          </div>
                          <Badge variant={client.status === "active" ? "default" : "outline"}>
                            {client.status}
                          </Badge>
                        </div>
                      </button>
                    );
                  })
                ) : (
                  <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center text-muted-foreground">
                    No tenant clients yet.
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Client Users</CardTitle>
                <CardDescription>
                  {selectedClient
                    ? `Users invited into ${selectedClient.name}.`
                    : "Select a client to view its users."}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!selectedClient ? (
                  <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center text-muted-foreground">
                    Choose a client first.
                  </div>
                ) : isLoadingUsers ? (
                  <div className="space-y-3">
                    {Array.from({ length: 4 }).map((_, index) => (
                      <Skeleton key={index} className="h-12 w-full" />
                    ))}
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>User</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Updated</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {clientUsers?.length ? (
                        clientUsers.map((user) => (
                          <TableRow key={user.id}>
                            <TableCell>
                              <div className="flex items-center gap-3">
                                <Users className="h-4 w-4 text-muted-foreground" />
                                <div>
                                  <div className="font-medium">{user.name || "Unnamed user"}</div>
                                  <div className="text-xs text-muted-foreground">{user.email}</div>
                                </div>
                              </div>
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline">{user.status}</Badge>
                            </TableCell>
                            <TableCell className="text-right text-sm text-muted-foreground">
                              {new Date(user.updated_at).toLocaleDateString()}
                            </TableCell>
                          </TableRow>
                        ))
                      ) : (
                        <TableRow>
                          <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                            No users invited yet.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </Layout>
    </ProtectedRoute>
  );
}
