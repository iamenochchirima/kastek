"use client";

import { useEffect, useState } from "react";
import { CreditCard, Loader2 } from "lucide-react";
import { ProtectedRoute } from "@/lib/auth";
import { Layout } from "@/components/layout";
import { tenantFetch } from "@/lib/api";
import { TENANT_ROUTE_ACCESS } from "@/lib/tenant-access";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type Invoice = {
  invoiceNumber: string;
  status: string;
  currency: string;
  totalMinor: string;
  issuedAt: string;
  paidAt: string | null;
  planKey: string | null;
};

type Plan = {
  key: string;
  name: string;
  description: string | null;
  product: string;
  currency: string;
  amountMinor: string;
  creditsPerPeriod: string | null;
  checkoutReady: boolean;
};

type Billing = {
  configured: boolean;
  account: {
    account?: { currency?: string; billing_email?: string };
    subscriptions?: Array<{
      id: string;
      product: string;
      planKey: string;
      planName: string;
      status: string;
      currentPeriodEnd: string | null;
      cancelAtPeriodEnd: boolean;
    }>;
    credits?: { balance: string; reserved: string; available: string };
    invoices?: Invoice[];
    issues?: Array<{ id: string; issueType: string; status: string }>;
  } | null;
  invoices: Invoice[];
  plans: Plan[];
};

function money(amountMinor: string | number | null, currency: string) {
  if (amountMinor === null) return "—";
  return new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(Number(amountMinor) / 100);
}

function usd(microUsd: string | null | undefined) {
  if (microUsd == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(microUsd) / 1_000_000);
}

function date(value: string | null) {
  return value
    ? new Date(value).toLocaleDateString("en-ZA", { dateStyle: "medium" })
    : "—";
}

export default function Billing() {
  const [data, setData] = useState<Billing | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void tenantFetch<Billing>("/api/billing")
      .then((result) => {
        if (active) setData(result);
      })
      .catch((cause) => {
        if (active)
          setError(
            cause instanceof Error ? cause.message : "Billing could not be loaded",
          );
      });
    return () => {
      active = false;
    };
  }, []);

  const account = data?.account;
  const subscription =
    account?.subscriptions?.find((item) => item.product === "agency") ??
    account?.subscriptions?.[0];
  const invoices = data?.invoices ?? account?.invoices ?? [];
  const plans = data?.plans ?? [];

  return (
    <ProtectedRoute allowedRoles={TENANT_ROUTE_ACCESS.billing}>
      <Layout>
        <div className="animate-in fade-in space-y-6 p-6 duration-500 sm:p-8">
          <div className="flex items-center gap-2">
            <CreditCard className="size-5 text-primary" />
            <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {!data && !error ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading billing…
            </p>
          ) : null}
          {data && !data.configured ? (
            <Card>
              <CardContent className="p-6 text-sm text-muted-foreground">
                Billing is not configured.
              </CardContent>
            </Card>
          ) : null}

          {data?.configured ? (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>Plan</CardDescription>
                    <CardTitle className="text-lg">
                      {subscription?.planName ?? "No active plan"}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {subscription ? (
                      <Badge variant="secondary" className="capitalize">
                        {subscription.status.replaceAll("_", " ")}
                      </Badge>
                    ) : null}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>Renews</CardDescription>
                    <CardTitle className="text-lg">
                      {subscription?.cancelAtPeriodEnd
                        ? `Ends ${date(subscription.currentPeriodEnd)}`
                        : date(subscription?.currentPeriodEnd ?? null)}
                    </CardTitle>
                  </CardHeader>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>AI usage available</CardDescription>
                    <CardTitle className="text-lg">
                      {usd(account?.credits?.available)}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0 text-xs text-muted-foreground">
                    {usd(account?.credits?.reserved)} reserved
                  </CardContent>
                </Card>
              </div>

              {plans.length ? (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Plans</CardTitle>
                    <CardDescription>Current monthly options.</CardDescription>
                  </CardHeader>
                  <CardContent className="divide-y divide-border p-0">
                    {plans.map((plan) => (
                      <div
                        key={plan.key}
                        className="flex flex-wrap items-center justify-between gap-3 px-6 py-3 text-sm"
                      >
                        <div>
                          <p className="font-medium">{plan.name}</p>
                          {plan.description ? (
                            <p className="text-xs text-muted-foreground">
                              {plan.description}
                            </p>
                          ) : null}
                        </div>
                        <div className="text-right">
                          <p>{money(plan.amountMinor, plan.currency)} / month</p>
                          <p className="text-xs text-muted-foreground">
                            {usd(plan.creditsPerPeriod)} AI usage
                          </p>
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              ) : null}

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Invoices</CardTitle>
                  <CardDescription>Your billing documents.</CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  {invoices.length ? (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[560px] text-left text-sm">
                        <thead className="border-b border-border text-xs text-muted-foreground">
                          <tr>
                            <th className="px-6 py-2 font-medium">Invoice</th>
                            <th className="px-6 py-2 font-medium">Issued</th>
                            <th className="px-6 py-2 text-right font-medium">Total</th>
                            <th className="px-6 py-2 text-right font-medium">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {invoices.map((invoice) => (
                            <tr key={invoice.invoiceNumber}>
                              <td className="px-6 py-3 font-mono text-xs">
                                {invoice.invoiceNumber}
                              </td>
                              <td className="px-6 py-3 text-muted-foreground">
                                {date(invoice.issuedAt)}
                              </td>
                              <td className="px-6 py-3 text-right">
                                {money(invoice.totalMinor, invoice.currency)}
                              </td>
                              <td className="px-6 py-3 text-right capitalize text-muted-foreground">
                                {invoice.status.replaceAll("_", " ")}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="px-6 py-4 text-sm text-muted-foreground">
                      No invoices yet
                    </p>
                  )}
                </CardContent>
              </Card>

              {account?.issues?.length ? (
                <p className="text-sm text-amber-600">
                  {account.issues.length} billing issue
                  {account.issues.length === 1 ? "" : "s"} need attention.
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      </Layout>
    </ProtectedRoute>
  );
}
