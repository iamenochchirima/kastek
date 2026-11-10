"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "@/lib/navigation";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth";
import { useTenantContext } from "@/lib/tenant-context-provider";
import { tenantFetch } from "@/lib/api";
import { AuthShell } from "@/components/auth-shell";
import { ArrowRight, ShieldCheck } from "lucide-react";

const emailSchema = z.object({
  email: z.string().email("Enter a valid email address"),
});

const passwordSchema = z.object({
  password: z.string().min(6, "Enter your password"),
});

type ContinueResponse = {
  audience?: "tenant" | "client" | "partner";
  availableAudiences?: Array<"tenant" | "client" | "partner">;
  nextStep: "password" | "setup_link_sent" | "partner_login" | "choose_audience" | "not_found";
  email?: string;
};

export default function Login() {
  const router = useRouter();
  const { login, isAuthenticated, defaultRoute } = useAuth();
  const { brandName, context, isLoading } = useTenantContext();
  const [stage, setStage] = useState<"email" | "password" | "setup_link_sent" | "partner_login" | "choose_audience">("email");
  const [email, setEmail] = useState("");
  const [audience, setAudience] = useState<"tenant" | "client" | "partner" | null>(null);
  const [availableAudiences, setAvailableAudiences] = useState<Array<"tenant" | "client" | "partner">>([]);
  const [choosingAudience, setChoosingAudience] = useState(false);

  const emailForm = useForm<z.infer<typeof emailSchema>>({
    resolver: zodResolver(emailSchema as never),
    defaultValues: { email: "" },
  });
  const passwordForm = useForm<z.infer<typeof passwordSchema>>({
    resolver: zodResolver(passwordSchema as never),
    defaultValues: { password: "" },
  });
  const portalMissing = !isLoading && !context.workspace && !context.branding;

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
      if (payload.nextStep === "choose_audience") {
        setAvailableAudiences(payload.availableAudiences ?? []);
        setStage("choose_audience");
        return;
      }
      applyContinueResponse(payload);
    } catch (error) {
      emailForm.setError("root", {
        message: error instanceof Error ? error.message : "Unable to continue with that email",
      });
    }
  }

  function applyContinueResponse(payload: ContinueResponse) {
    setAudience(payload.audience ?? null);
    if (payload.nextStep === "password") {
      setStage("password");
      passwordForm.reset({ password: "" });
    } else if (payload.nextStep === "setup_link_sent") {
      setStage("setup_link_sent");
    } else if (payload.nextStep === "partner_login") {
      setStage("partner_login");
    } else {
      setStage("email");
      emailForm.setError("root", { message: "No access was found for that email in this portal." });
    }
  }

  async function continueAsAudience(selectedAudience: "tenant" | "client" | "partner") {
    if (selectedAudience === "partner") {
      setAudience("partner");
      setStage("partner_login");
      return;
    }
    setChoosingAudience(true);
    emailForm.clearErrors("root");
    try {
      const payload = await tenantFetch<ContinueResponse>("/api/auth/session/continue", {
        method: "POST",
        body: JSON.stringify({ email, audience: selectedAudience }),
      });
      applyContinueResponse(payload);
    } catch (error) {
      emailForm.setError("root", { message: error instanceof Error ? error.message : "Unable to continue with that account." });
      setStage("email");
    } finally {
      setChoosingAudience(false);
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
    setAvailableAudiences([]);
    passwordForm.reset({ password: "" });
  }

  if (isLoading) {
    return (
      <AuthShell>
        <p className="auth-kicker">Portal access</p>
        <h1 className="auth-card-title mt-3">Preparing your workspace.</h1>
        <p className="auth-card-description">
          We are checking this portal and your access.
        </p>
        <div className="mt-8 space-y-3" aria-hidden="true">
          <div className="h-11 animate-pulse rounded-md bg-[#182b250d]" />
          <div className="h-11 animate-pulse rounded-md bg-[#182b250d]" />
          <div className="h-11 animate-pulse rounded-md bg-[#182b250d]" />
        </div>
      </AuthShell>
    );
  }

  if (portalMissing) {
    return (
      <AuthShell>
        <p className="auth-kicker">Portal unavailable</p>
        <h1 className="auth-card-title mt-3">This portal is not available.</h1>
        <p className="auth-card-description">
          Check the link and try again, or contact support if you need a new
          portal setup.
        </p>
        <a className="auth-primary mt-8" href="mailto:support@kasitek.co.za">
          Contact support
          <ArrowRight size={17} aria-hidden="true" />
        </a>
      </AuthShell>
    );
  }

  const title =
    stage === "email"
      ? brandName === "Portal"
        ? "Sign in to your portal."
        : `Sign in to ${brandName}.`
      : stage === "password"
        ? "Enter your password."
        : stage === "partner_login"
          ? "Partner sign in."
          : stage === "choose_audience"
            ? "Choose your account."
            : "Check your inbox.";
  const description =
    stage === "email"
      ? "Use the email connected to this workspace."
      : stage === "password"
        ? "This email already has access. Enter the password to continue."
        : stage === "partner_login"
          ? "This business is connected to your KasiTek partner account."
          : stage === "choose_audience"
            ? "This email has more than one account in this business."
            : "We have sent a secure setup link to finish creating your access.";

  return (
    <AuthShell>
      <h1 className="auth-card-title">{title}</h1>
      <p className="auth-card-description">{description}</p>

      <div className="mt-6">
        {stage === "email" ? (
          <Form {...emailForm}>
            <form onSubmit={emailForm.handleSubmit(onContinue)} className="space-y-4">
              <FormField
                control={emailForm.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="auth-label">Email</FormLabel>
                    <FormControl>
                      <Input placeholder="admin@tenant.com" {...field} className="auth-input" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {emailForm.formState.errors.root ? (
                <p className="auth-error">{emailForm.formState.errors.root.message}</p>
              ) : null}

              <button type="submit" className="auth-primary" disabled={emailForm.formState.isSubmitting}>
                {emailForm.formState.isSubmitting ? "Checking access..." : "Continue"}
                <ArrowRight size={17} aria-hidden="true" />
              </button>
            </form>
          </Form>
        ) : null}

        {stage === "password" ? (
          <Form {...passwordForm}>
            <form onSubmit={passwordForm.handleSubmit(onPasswordSubmit)} className="space-y-4">
              <div className="rounded-lg border border-[#171a221f] bg-[#f8f6ef] px-4 py-3 text-sm">
                <div className="font-medium text-[#171a22]">{email}</div>
                <div className="text-[#626874]">
                  {audience === "client" ? "Client portal access" : "Tenant admin access"}
                </div>
              </div>

              <FormField
                control={passwordForm.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="auth-label">Password</FormLabel>
                    <FormControl>
                      <Input type="password" placeholder="••••••••" {...field} className="auth-input" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {passwordForm.formState.errors.root ? (
                <p className="auth-error">{passwordForm.formState.errors.root.message}</p>
              ) : null}

              <div className="flex gap-3">
                <button
                  type="button"
                  className="inline-flex min-h-11 flex-1 items-center justify-center rounded-md border border-[#171a221f] bg-transparent px-4 text-sm font-medium text-[#171a22]"
                  onClick={resetToEmail}
                >
                  Back
                </button>
                <button type="submit" className="auth-primary flex-1" disabled={passwordForm.formState.isSubmitting}>
                  {passwordForm.formState.isSubmitting ? "Signing in..." : "Sign in"}
                </button>
              </div>
            </form>
          </Form>
        ) : null}

        {stage === "setup_link_sent" ? (
          <div className="space-y-4">
            <div className="auth-note">
              We have sent a secure setup link to{" "}
              <span className="font-medium text-[#171a22]">{email}</span>.
            </div>
            <button
              type="button"
              className="inline-flex min-h-11 w-full items-center justify-center rounded-md border border-[#171a221f] bg-transparent px-4 text-sm font-medium text-[#171a22]"
              onClick={resetToEmail}
            >
              Use a different email
            </button>
          </div>
        ) : null}

        {stage === "partner_login" ? (
          <div className="space-y-4">
            <div className="auth-note">
              <span className="font-medium text-[#171a22]">{email}</span> signs
              in through KasiTek Login, not a separate portal password.
            </div>
            <a
              href={`/api/tenant/api/partner/auth/start?returnTo=${encodeURIComponent(context.workspace?.slug ? `/portal/${context.workspace.slug}` : "/app/businesses")}`}
              className="auth-primary"
            >
              Continue with KasiTek Login
              <ArrowRight size={17} aria-hidden="true" />
            </a>
            <button
              type="button"
              className="inline-flex min-h-11 w-full items-center justify-center rounded-md border border-[#171a221f] bg-transparent px-4 text-sm font-medium text-[#171a22]"
              onClick={resetToEmail}
            >
              Use a different email
            </button>
          </div>
        ) : null}

        {stage === "choose_audience" ? (
          <div className="space-y-3">
            {availableAudiences.map((available) => (
              <button
                key={available}
                type="button"
                className={available === "partner" ? "auth-primary" : "inline-flex min-h-11 w-full items-center justify-center rounded-md border border-[#171a221f] bg-transparent px-4 text-sm font-medium text-[#171a22]"}
                disabled={choosingAudience}
                onClick={() => void continueAsAudience(available)}
              >
                {choosingAudience
                  ? "Checking account..."
                  : available === "partner"
                    ? "Agency partner account"
                    : available === "tenant"
                      ? "Agency team account"
                      : "Client account"}
              </button>
            ))}
            <button
              type="button"
              className="inline-flex min-h-10 w-full items-center justify-center px-4 text-sm text-[#626874]"
              onClick={resetToEmail}
            >
              Use a different email
            </button>
          </div>
        ) : null}
      </div>

      <p className="auth-security">
        <ShieldCheck size={15} aria-hidden="true" />
        Your access is scoped to this portal. Agency staff sign in through
        KasiTek Identity.
      </p>
    </AuthShell>
  );
}
