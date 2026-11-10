"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "@/lib/navigation";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { tenantFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { TenantBrandMark } from "@/components/tenant-brand";
import { useTenantContext } from "@/lib/tenant-context-provider";
import { AuthShell } from "@/components/auth-shell";
import { ArrowRight, ShieldCheck } from "lucide-react";

const acceptInviteSchema = z
  .object({
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string().min(8, "Confirm your password"),
    name: z.string().optional(),
  })
  .refine((values) => values.password === values.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords do not match",
  });

export default function AcceptInviteScreen() {
  const router = useRouter();
  const { refresh } = useAuth();
  const { brandName, tagline } = useTenantContext();
  const searchParams = useSearchParams();
  const [success, setSuccess] = useState(false);
  const [inviteEmail, setInviteEmail] = useState<string | null>(null);
  const [tenantClientName, setTenantClientName] = useState<string | null>(null);
  const [workspaceDisplayName, setWorkspaceDisplayName] = useState<string | null>(null);
  const [isLoadingInvite, setIsLoadingInvite] = useState(true);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const token = useMemo(() => searchParams.get("token") ?? "", [searchParams]);

  const form = useForm<z.infer<typeof acceptInviteSchema>>({
    resolver: zodResolver(acceptInviteSchema as never),
    defaultValues: {
      password: "",
      confirmPassword: "",
      name: "",
    },
  });

  useEffect(() => {
    let active = true;

    if (!token) {
      setInviteError("Invite token is missing");
      setIsLoadingInvite(false);
      return;
    }

    void tenantFetch<{
      invite: {
        email: string;
        name?: string | null;
        tenantClientName: string;
        workspaceDisplayName: string;
        isValid: boolean;
      };
    }>(`/api/client-auth/invite?token=${encodeURIComponent(token)}`, {
      method: "GET",
    })
      .then((payload) => {
        if (!active) {
          return;
        }

        if (!payload.invite.isValid) {
          setInviteError("This invite is no longer valid");
          return;
        }

        setInviteEmail(payload.invite.email);
        setTenantClientName(payload.invite.tenantClientName);
        setWorkspaceDisplayName(payload.invite.workspaceDisplayName);
        form.setValue("name", payload.invite.name ?? "");
      })
      .catch((error) => {
        if (active) {
          setInviteError(error instanceof Error ? error.message : "Unable to load invite");
        }
      })
      .finally(() => {
        if (active) {
          setIsLoadingInvite(false);
        }
      });

    return () => {
      active = false;
    };
  }, [form, token]);

  const onSubmit = async (values: z.infer<typeof acceptInviteSchema>) => {
    if (!token) {
      form.setError("root", { message: "Invite token is missing" });
      return;
    }

    try {
      await tenantFetch("/api/client-auth/accept-invite", {
        method: "POST",
        body: JSON.stringify({
          token,
          password: values.password,
          name: values.name,
        }),
      });
      await refresh();
      setSuccess(true);
      setTimeout(() => router.replace("/client"), 900);
    } catch (error) {
      form.setError("root", {
        message: error instanceof Error ? error.message : "Unable to accept invite",
      });
    }
  };

  return (
    <AuthShell>
      <div className="text-center">
        <div className="flex justify-center">
          <TenantBrandMark />
        </div>
        <p className="auth-kicker mt-5">Client invitation</p>
        <h1 className="auth-card-title mt-2">{brandName}</h1>
        <p className="auth-card-description">
          {workspaceDisplayName && tenantClientName
            ? `Set credentials for ${tenantClientName} inside ${workspaceDisplayName}.`
            : `Create credentials for your ${tagline.toLowerCase()}.`}
        </p>
      </div>

      <div className="mt-8">
        {isLoadingInvite ? (
          <div className="space-y-3" aria-hidden="true">
            <div className="h-11 animate-pulse rounded-md bg-[#171a220d]" />
            <div className="h-11 animate-pulse rounded-md bg-[#171a220d]" />
            <div className="h-11 animate-pulse rounded-md bg-[#171a220d]" />
          </div>
        ) : inviteError ? (
          <div className="rounded-lg border border-[#a83c3433] bg-[#a83c340f] px-4 py-5 text-center text-sm text-[#81352e]">
            {inviteError}
          </div>
        ) : success ? (
          <div className="rounded-lg border border-[#171a221f] bg-[#f8f6ef] px-4 py-5 text-center text-sm text-[#171a22]">
            Account activated. Redirecting to your client portal.
          </div>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              {inviteEmail && (
                <div className="rounded-lg border border-[#171a221f] bg-[#f8f6ef] px-4 py-3 text-sm">
                  <div className="font-medium text-[#171a22]">{inviteEmail}</div>
                  <div className="text-[#626874]">This invited email will be used for sign-in.</div>
                </div>
              )}
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="auth-label">Name</FormLabel>
                    <FormControl>
                      <Input className="auth-input" placeholder="Jane Doe" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="auth-label">Password</FormLabel>
                    <FormControl>
                      <Input className="auth-input" type="password" placeholder="At least 8 characters" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="confirmPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="auth-label">Confirm password</FormLabel>
                    <FormControl>
                      <Input className="auth-input" type="password" placeholder="Repeat your password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {form.formState.errors.root ? (
                <p className="auth-error">{form.formState.errors.root.message}</p>
              ) : null}
              <button type="submit" className="auth-primary" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? "Activating..." : "Activate client access"}
                <ArrowRight size={17} aria-hidden="true" />
              </button>
            </form>
          </Form>
        )}
      </div>

      <p className="auth-security">
        <ShieldCheck size={15} aria-hidden="true" />
        Your access is scoped to this client workspace. Your password is stored
        securely and never shared with other clients.
      </p>
    </AuthShell>
  );
}
