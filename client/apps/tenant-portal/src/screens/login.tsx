"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { tenantFetch } from "@/lib/api";
import { BrainCircuit } from "lucide-react";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export default function Login() {
  const router = useRouter();
  const { login, isAuthenticated, defaultRoute } = useAuth();
  const [tenantName, setTenantName] = useState("AgencyOS");
  const [tenantTagline, setTenantTagline] = useState("AI Command Center");

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

  useEffect(() => {
    let active = true;

    void tenantFetch<{
      workspace?: { displayName?: string };
      branding?: { displayName?: string };
    }>("/api/public/tenant-context", { method: "GET" })
      .then((payload) => {
        if (!active) {
          return;
        }

        setTenantName(
          payload.branding?.displayName || payload.workspace?.displayName || "AgencyOS",
        );
        setTenantTagline("Tenant Command Center");
      })
      .catch(() => {
        if (active) {
          setTenantName("AgencyOS");
          setTenantTagline("AI Command Center");
        }
      });

    return () => {
      active = false;
    };
  }, []);

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
    <div className="min-h-screen w-full flex items-center justify-center bg-background p-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-primary/20 via-background to-background"></div>
      
      <div className="relative z-10 w-full max-w-md space-y-8">
        <div className="text-center space-y-2">
          <div className="mx-auto w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center mb-6 ring-1 ring-primary/20 shadow-lg shadow-primary/20">
            <BrainCircuit className="w-6 h-6 text-primary" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">{tenantName}</h1>
          <p className="text-muted-foreground">{tenantTagline}</p>
        </div>

        <Card className="border-border/50 shadow-2xl bg-card/50 backdrop-blur-xl">
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
                        <Input placeholder="admin@demo.com" {...field} className="bg-background/50" />
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
                        <Input type="password" placeholder="••••••••" {...field} className="bg-background/50" />
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
  );
}
