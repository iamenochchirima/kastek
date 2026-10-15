"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { buttonClassName } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type Product = { key: string; name: string; description: string | null; active: boolean };
type Plan = {
  key: string;
  productKey: string;
  name: string;
  interval: string;
  currency: string;
  amountMinor: number | null;
  creditsPerPeriod: number | null;
  active: boolean;
  paystackPlanCode: string | null;
};
type Entitlement = { planKey: string; key: string; value: unknown };
type AccessDefinition = { key: string; name: string; kind: "capability" | "meter" };

async function submit(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Billing catalogue update failed");
}

export function BillingCatalogManager({
  products,
  plans,
  entitlements,
  accessDefinitions,
}: {
  products: Product[];
  plans: Plan[];
  entitlements: Entitlement[];
  accessDefinitions: AccessDefinition[];
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function handle(
    event: FormEvent<HTMLFormElement>,
    path: string,
    build: (data: FormData) => unknown,
  ) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await submit(path, build(new FormData(event.currentTarget)));
      event.currentTarget.reset();
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Update failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {error ? <p role="alert" className="rounded-md border border-status-danger/25 bg-status-danger-soft p-3 text-sm text-status-danger">{error}</p> : null}
      <div className="grid gap-6 xl:grid-cols-3">
        <form className="v-card space-y-3 p-[var(--density-card-padding)]" onSubmit={(event) => handle(event, "/api/billing/products", (data) => ({ key: data.get("key"), name: data.get("name"), description: data.get("description") || null, active: data.get("active") === "on" }))}>
          <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">Create or update offering</h2>
          <FormField id="offering-key" label="Offering key" required><Input id="offering-key" name="key" placeholder="workspace" required /></FormField>
          <FormField id="offering-name" label="Name" required><Input id="offering-name" name="name" placeholder="KasiTek Workspace" required /></FormField>
          <FormField id="offering-description" label="Description"><Textarea id="offering-description" name="description" placeholder="Internal billing catalogue description" /></FormField>
          <label className="flex items-center gap-2 text-sm text-muted-foreground"><Checkbox name="active" defaultChecked /> Active</label>
          <button type="submit" disabled={saving} className={buttonClassName({ size: "sm" })}>Save offering</button>
        </form>

        <form className="v-card space-y-3 p-[var(--density-card-padding)]" onSubmit={(event) => handle(event, "/api/billing/plans", (data) => ({ productKey: data.get("productKey"), key: data.get("key"), name: data.get("name"), interval: data.get("interval"), currency: data.get("currency"), amountMinor: Number(data.get("amountMinor")), creditsPerPeriod: Number(data.get("creditsPerPeriod")), paystackPlanCode: data.get("paystackPlanCode") || null, active: data.get("active") === "on" }))}>
          <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">Create or update plan</h2>
          <FormField id="plan-product" label="Product" required><Select id="plan-product" name="productKey" required><option value="" disabled>Select product</option>{products.map((product) => <option key={product.key} value={product.key}>{product.name}</option>)}</Select></FormField>
          <FormField id="plan-key" label="Plan key" required><Input id="plan-key" name="key" placeholder="workspace-starter-monthly" required /></FormField>
          <FormField id="plan-name" label="Name" required><Input id="plan-name" name="name" placeholder="Starter" required /></FormField>
          <div className="grid grid-cols-2 gap-2"><FormField id="plan-interval" label="Interval"><Select id="plan-interval" name="interval"><option>MONTHLY</option><option>YEARLY</option></Select></FormField><FormField id="plan-currency" label="Currency" required><Input id="plan-currency" name="currency" defaultValue="ZAR" required /></FormField></div>
          <FormField id="plan-amount" label="Amount in cents" required><Input id="plan-amount" name="amountMinor" type="number" min="0" placeholder="39900" required /></FormField>
          <FormField id="plan-credits" label="Credits per period" required><Input id="plan-credits" name="creditsPerPeriod" type="number" min="1" placeholder="5000" required /></FormField>
          <FormField id="plan-paystack-code" label="Paystack plan code" hint="Optional until the Paystack plan is created."><Input id="plan-paystack-code" name="paystackPlanCode" placeholder="PLN_..." /></FormField>
          <label className="flex items-center gap-2 text-sm text-muted-foreground"><Checkbox name="active" /> Active for checkout</label>
          <button type="submit" disabled={saving} className={buttonClassName({ size: "sm" })}>Save plan</button>
        </form>

        <form className="v-card space-y-3 p-[var(--density-card-padding)]" onSubmit={(event) => handle(event, "/api/billing/entitlements", (data) => { const raw = String(data.get("value")); const value = raw === "true" ? true : raw === "false" ? false : Number.isNaN(Number(raw)) ? raw : Number(raw); return { planKey: data.get("planKey"), key: data.get("key"), value }; })}>
          <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">Set plan entitlement</h2>
          <FormField id="entitlement-plan" label="Plan" required><Select id="entitlement-plan" name="planKey" required><option value="" disabled>Select plan</option>{plans.map((plan) => <option key={plan.key} value={plan.key}>{plan.name} ({plan.key})</option>)}</Select></FormField>
          <FormField id="entitlement-key" label="Capability or meter" required><Select id="entitlement-key" name="key" required><option value="">Choose capability or meter</option>{accessDefinitions.map((definition) => <option key={definition.key} value={definition.key}>{definition.name} · {definition.kind}</option>)}</Select></FormField>
          <FormField id="entitlement-value" label="Value" required><Input id="entitlement-value" name="value" placeholder="true or numeric limit" required /></FormField>
          <button type="submit" disabled={saving} className={buttonClassName({ size: "sm" })}>Save entitlement</button>
        </form>
      </div>

      <section className="v-card p-[var(--density-card-padding)]">
        <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">Configured plans</h2>
        <div className="mt-4 divide-y divide-line">
          {plans.map((plan) => (
            <div key={plan.key} className="flex flex-wrap justify-between gap-3 py-3 text-sm">
              <div><p className="font-medium text-foreground">{plan.name} · {plan.productKey}</p><p className="text-muted-foreground">{plan.key} · {entitlements.filter((item) => item.planKey === plan.key).length} entitlements</p></div>
              <div className="text-right text-muted-foreground"><p>{plan.currency} {plan.amountMinor === null ? "—" : (plan.amountMinor / 100).toFixed(2)} / {plan.interval.toLowerCase()}</p><p>{plan.creditsPerPeriod?.toLocaleString() ?? "No credit allowance"} credits · {plan.active ? "Active" : "Draft"} · {plan.paystackPlanCode || "No Paystack code"}</p></div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
