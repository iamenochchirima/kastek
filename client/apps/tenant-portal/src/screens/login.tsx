"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { TenantBrandMark } from "@/components/tenant-brand";
import { useTenantContext } from "@/lib/tenant-context-provider";
import { tenantFetch } from "@/lib/api";

const emailSchema = z.object({
  email: z.string().email("Enter a valid email address"),
});

const passwordSchema = z.object({
  password: z.string().min(6, "Enter your password"),
});

type ContinueResponse = {
  audience?: "tenant" | "client";
  nextStep: "password" | "setup_link_sent" | "not_found";
  email?: string;
  activationUrl?: string | null;
  portalUrl?: string | null;
  expiresAt?: string | null;
};

export default function Login() {
  const router = useRouter();
  const { login, isAuthenticated, defaultRoute } = useAuth();
  const { brandName, tagline, context, isLoading } = useTenantContext();
  const [stage, setStage] = useState<"email" | "password" | "setup_link_sent">("email");
  const [email, setEmail] = useState("");
  const [audience, setAudience] = useState<"tenant" | "client" | null>(null);
  const [activationUrl, setActivationUrl] = useState<string | null>(null);
  const [portalUrl, setPortalUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);

  const emailForm = useForm<z.infer<typeof emailSchema>>({
    resolver: zodResolver(emailSchema),
    defaultValues: { email: "" },
  });
  const passwordForm = useForm<z.infer<typeof passwordSchema>>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { password: "" },
  });

  useEffect(() => {
    if (isAuthenticated) {
      router.replace(defaultRoute);
    }
  }, [defaultRoute, isAuthenticated, router]);

  async function onContinue(values: z.infer<typeof emailSchema>) {
    try {
      const payload = await tenantFetch<ContinueResponse>("/api/auth/session/continue", {
        method: "POST",
        body: JSON.stringify({ email: values.email }),
      });

      setEmail(values.email);
      setAudience(payload.audience ?? null);
      setActivationUrl(payload.activationUrl ?? null);
      setPortalUrl(payload.portalUrl ?? null);
      setExpiresAt(payload.expiresAt ?? null);

      if (payload.nextStep === "password") {
        setStage("password");
        passwordForm.reset({ password: "" });
        return;
      }

      if (payload.nextStep === "setup_link_sent") {
        setStage("setup_link_sent");
        return;
      }

      emailForm.setError("root", {
        message: "No access was found for that email in this portal.",
      });
    } catch (error) {
      emailForm.setError("root", {
        message: error instanceof Error ? error.message : "Unable to continue with that email",
      });
    }
  }

  async function onPasswordSubmit(values: z.infer<typeof passwordSchema>) {
    try {
      const result = await login(email, values.password);
      router.replace(result === "client" ? "/client" : "/");
    } catch (error) {
      passwordForm.setError("root", {
        message: error instanceof Error ? error.message : "Unable to sign in with those credentials",
      });
    }
  }

  function resetToEmail() {
    setStage("email");
    setAudience(null);
    setActivationUrl(null);
    setPortalUrl(null);
    setExpiresAt(null);
    passwordForm.reset({ password: "" });
  }

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-background p-4">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-primary/20 via-background to-background" />
      <div className="absolute left-1/2 top-0 h-72 w-[42rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-md items-center">
        <div className="w-full space-y-8">
          <div className="rounded-3xl border border-border/60 bg-card/60 p-6 text-center shadow-2xl backdrop-blur-xl">
            <div className="mx-auto mb-4 flex items-center justify-center">
              <TenantBrandMark className="ring-1 ring-primary/20 shadow-lg shadow-primary/20" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">{brandName}</h1>
            <p className="mt-2 text-muted-foreground">{tagline}</p>
            {context.workspace?.slug ? (
              <p className="mt-3 text-xs uppercase tracking-[0.2em] text-muted-foreground">
                Portal {context.workspace.slug}
              </p>
            ) : null}
          </div>

          <div className="space-y-3 text-center">
            <h2 className="text-sm font-medium uppercase tracking-[0.24em] text-muted-foreground">
              Shared portal access
            </h2>
            <p className="text-sm text-muted-foreground">
              Start with your email. We’ll guide you to sign in or finish setting up your access.
            </p>
            {isLoading ? <p className="text-xs text-muted-foreground">Loading workspace branding...</p> : null}
          </div>

          <Card className="border-border/50 bg-card/80 shadow-2xl backdrop-blur-xl">
            <CardHeader>
              <CardTitle>
                {stage === "email" ? "Access your portal" : stage === "password" ? "Enter your password" : "Check your inbox"}
              </CardTitle>
              <CardDescription>
                {stage === "email"
                  ? "Use the email address connected to this portal."
                  : stage === "password"
                    ? "This email already has access. Enter the password to continue."
                    : "We’ve sent a secure setup link so you can finish creating your access."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {stage === "email" ? (
                <Form {...emailForm}>
                  <form onSubmit={emailForm.handleSubmit(onContinue)} className="space-y-4">
                    <FormField
                      control={emailForm.control}
                      name="email"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Email</FormLabel>
                          <FormControl>
                            <Input placeholder="admin@tenant.com" {...field} className="bg-background/50" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {emailForm.formState.errors.root ? (
                      <p className="text-sm text-destructive">{emailForm.formState.errors.root.message}</p>
                    ) : null}

                    <Button type="submit" className="w-full" size="lg">
                      Continue
                    </Button>
                  </form>
                </Form>
              ) : null}

              {stage === "password" ? (
                <Form {...passwordForm}>
                  <form onSubmit={passwordForm.handleSubmit(onPasswordSubmit)} className="space-y-4">
                    <div className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm">
                      <div className="font-medium">{email}</div>
                      <div className="text-muted-foreground">
                        {audience === "client" ? "Client portal access" : "Tenant admin access"}
                      </div>
                    </div>

                    <FormField
                      control={passwordForm.control}
                      name="password"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Password</FormLabel>
                          <FormControl>
                            <Input type="password" placeholder="••••••••" {...field} className="bg-background/50" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {passwordForm.formState.errors.root ? (
                      <p className="text-sm text-destructive">{passwordForm.formState.errors.root.message}</p>
                    ) : null}

                    <div className="flex gap-3">
                      <Button type="button" variant="outline" className="flex-1" onClick={resetToEmail}>
                        Back
                      </Button>
                      <Button type="submit" className="flex-1">
                        Sign in
                      </Button>
                    </div>
                  </form>
                </Form>
              ) : null}

              {stage === "setup_link_sent" ? (
                <div className="space-y-4">
                  <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-4 text-sm text-muted-foreground">
                    <div className="font-medium text-foreground">{email}</div>
                    <div className="mt-2">
                      We sent a secure setup link to this email so you can create your password and finish access setup.
                    </div>
                    {expiresAt ? (
                      <div className="mt-2 text-xs">Link expires {new Date(expiresAt).toLocaleString()}.</div>
                    ) : null}
                  </div>

                  {portalUrl ? (
                    <div className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm">
                      <div className="text-muted-foreground">Portal link</div>
                      <div className="mt-1 break-all font-mono text-foreground">{portalUrl}</div>
                    </div>
                  ) : null}

                  {activationUrl ? (
                    <div className="space-y-3">
                      <Button asChild className="w-full">
                        <Link href={activationUrl}>Open setup link</Link>
                      </Button>
                      <p className="text-xs text-muted-foreground">
                        The link above is shown here as a fallback so you can test the flow immediately.
                      </p>
                    </div>
                  ) : null}

                  <Button type="button" variant="outline" className="w-full" onClick={resetToEmail}>
                    Use a different email
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
