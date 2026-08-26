"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { buttonClassName } from "@/components/ui/button";

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

const fieldClass = "h-[var(--density-control-height)] w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50";
const areaClass = "min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50";

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
          <input className={fieldClass} name="key" placeholder="workspace" required />
          <input className={fieldClass} name="name" placeholder="KasiTek Workspace" required />
          <textarea className={areaClass} name="description" placeholder="Internal billing catalogue description" />
          <label className="flex gap-2 text-sm text-muted-foreground"><input type="checkbox" name="active" defaultChecked /> Active</label>
          <button type="submit" disabled={saving} className={buttonClassName({ size: "sm" })}>Save offering</button>
        </form>

        <form className="v-card space-y-3 p-[var(--density-card-padding)]" onSubmit={(event) => handle(event, "/api/billing/plans", (data) => ({ productKey: data.get("productKey"), key: data.get("key"), name: data.get("name"), interval: data.get("interval"), currency: data.get("currency"), amountMinor: Number(data.get("amountMinor")), creditsPerPeriod: Number(data.get("creditsPerPeriod")), paystackPlanCode: data.get("paystackPlanCode") || null, active: data.get("active") === "on" }))}>
          <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">Create or update plan</h2>
          <select className={fieldClass} name="productKey" required>{products.map((product) => <option key={product.key} value={product.key}>{product.name}</option>)}</select>
          <input className={fieldClass} name="key" placeholder="workspace-starter-monthly" required />
          <input className={fieldClass} name="name" placeholder="Starter" required />
          <div className="grid grid-cols-2 gap-2"><select className={fieldClass} name="interval"><option>MONTHLY</option><option>YEARLY</option></select><input className={fieldClass} name="currency" defaultValue="ZAR" required /></div>
          <input className={fieldClass} name="amountMinor" type="number" min="0" placeholder="Amount in cents" required />
          <input className={fieldClass} name="creditsPerPeriod" type="number" min="1" placeholder="Credits per period" required />
          <input className={fieldClass} name="paystackPlanCode" placeholder="PLN_..." />
          <label className="flex gap-2 text-sm text-muted-foreground"><input type="checkbox" name="active" /> Active for checkout</label>
          <button type="submit" disabled={saving} className={buttonClassName({ size: "sm" })}>Save plan</button>
        </form>

        <form className="v-card space-y-3 p-[var(--density-card-padding)]" onSubmit={(event) => handle(event, "/api/billing/entitlements", (data) => { const raw = String(data.get("value")); const value = raw === "true" ? true : raw === "false" ? false : Number.isNaN(Number(raw)) ? raw : Number(raw); return { planKey: data.get("planKey"), key: data.get("key"), value }; })}>
          <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">Set plan entitlement</h2>
          <select className={fieldClass} name="planKey" required>{plans.map((plan) => <option key={plan.key} value={plan.key}>{plan.name} ({plan.key})</option>)}</select>
          <select className={fieldClass} name="key" required><option value="">Choose capability or meter</option>{accessDefinitions.map((definition) => <option key={definition.key} value={definition.key}>{definition.name} · {definition.kind}</option>)}</select>
          <input className={fieldClass} name="value" placeholder="true or numeric limit" required />
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
