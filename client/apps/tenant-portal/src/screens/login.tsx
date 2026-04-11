"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { TenantBrandMark } from "@/components/tenant-brand";
import { useTenantContext } from "@/lib/tenant-context-provider";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export default function Login() {
  const router = useRouter();
  const { login, isAuthenticated, defaultRoute } = useAuth();
  const { brandName, tagline, context, isLoading } = useTenantContext();

  const form = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  useEffect(() => {
    if (isAuthenticated) {
      router.replace(defaultRoute);
    }
  }, [defaultRoute, isAuthenticated, router]);

  async function onSubmit(data: z.infer<typeof loginSchema>) {
    try {
      const audience = await login(data.email, data.password);
      router.replace(audience === "client" ? "/client" : "/");
    } catch (error) {
      form.setError("root", {
        message:
          error instanceof Error ? error.message : "Unable to sign in with those credentials",
      });
    }
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
                Workspace {context.workspace.slug}
              </p>
            ) : null}
          </div>

          <div className="space-y-3 text-center">
            <h2 className="text-sm font-medium uppercase tracking-[0.24em] text-muted-foreground">
              Shared portal access
            </h2>
            <p className="text-sm text-muted-foreground">
              Use your tenant staff or client credentials to continue into this workspace.
            </p>
            {isLoading ? (
              <p className="text-xs text-muted-foreground">Loading workspace branding...</p>
            ) : null}
          </div>

          <Card className="border-border/50 bg-card/80 shadow-2xl backdrop-blur-xl">
            <CardHeader>
              <CardTitle>Welcome back</CardTitle>
              <CardDescription>Enter your credentials to access the platform</CardDescription>
            </CardHeader>
            <CardContent>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                  <FormField
                    control={form.control}
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
                  <FormField
                    control={form.control}
                    name="password"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Password</FormLabel>
                        <FormControl>
                          <Input
                            type="password"
                            placeholder="••••••••"
                            {...field}
                            className="bg-background/50"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {form.formState.errors.root && (
                    <p className="text-sm text-destructive">{form.formState.errors.root.message}</p>
                  )}

                  <Button type="submit" className="w-full" size="lg">
                    Access Command Center
                  </Button>
                </form>
              </Form>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
