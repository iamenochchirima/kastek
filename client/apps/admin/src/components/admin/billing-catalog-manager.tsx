"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

type Product = { key: string; name: string; description: string | null; active: boolean };
type Plan = { key: string; productKey: string; name: string; interval: string; currency: string; amountMinor: number | null; active: boolean; paystackPlanCode: string | null };
type Entitlement = { planKey: string; key: string; value: unknown };
type AccessDefinition = { key: string; name: string; kind: "capability" | "meter" };

async function submit(path: string, body: unknown) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Billing catalogue update failed");
}

export function BillingCatalogManager({ products, plans, entitlements, accessDefinitions }: { products: Product[]; plans: Plan[]; entitlements: Entitlement[]; accessDefinitions: AccessDefinition[] }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function handle(event: FormEvent<HTMLFormElement>, path: string, build: (data: FormData) => unknown) {
    event.preventDefault(); setSaving(true); setError("");
    try { await submit(path, build(new FormData(event.currentTarget))); event.currentTarget.reset(); router.refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Update failed"); }
    finally { setSaving(false); }
  }

  const input = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text";
  return <div className="space-y-6">
    {error ? <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</p> : null}
    <div className="grid gap-6 xl:grid-cols-3">
      <form className="space-y-3 rounded-xl border border-border bg-surface-raised p-5" onSubmit={(event) => handle(event, "/api/billing/products", (data) => ({ key: data.get("key"), name: data.get("name"), description: data.get("description") || null, active: data.get("active") === "on" }))}>
        <h2 className="font-semibold text-text">Create or update offering</h2>
        <input className={input} name="key" placeholder="workspace" required /><input className={input} name="name" placeholder="KasiTek Workspace" required /><textarea className={input} name="description" placeholder="Internal billing catalogue description" />
        <label className="flex gap-2 text-sm text-text-muted"><input type="checkbox" name="active" defaultChecked /> Active</label><button disabled={saving} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-black">Save offering</button>
      </form>
      <form className="space-y-3 rounded-xl border border-border bg-surface-raised p-5" onSubmit={(event) => handle(event, "/api/billing/plans", (data) => ({ productKey: data.get("productKey"), key: data.get("key"), name: data.get("name"), interval: data.get("interval"), currency: data.get("currency"), amountMinor: Number(data.get("amountMinor")), paystackPlanCode: data.get("paystackPlanCode") || null, active: data.get("active") === "on" }))}>
        <h2 className="font-semibold text-text">Create or update plan</h2>
        <select className={input} name="productKey" required>{products.map((product) => <option key={product.key} value={product.key}>{product.name}</option>)}</select><input className={input} name="key" placeholder="workspace-starter-monthly" required /><input className={input} name="name" placeholder="Starter" required />
        <div className="grid grid-cols-2 gap-2"><select className={input} name="interval"><option>MONTHLY</option><option>YEARLY</option></select><input className={input} name="currency" defaultValue="ZAR" required /></div><input className={input} name="amountMinor" type="number" min="0" placeholder="Amount in cents" required /><input className={input} name="paystackPlanCode" placeholder="PLN_..." />
        <label className="flex gap-2 text-sm text-text-muted"><input type="checkbox" name="active" /> Active for checkout</label><button disabled={saving} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-black">Save plan</button>
      </form>
      <form className="space-y-3 rounded-xl border border-border bg-surface-raised p-5" onSubmit={(event) => handle(event, "/api/billing/entitlements", (data) => { const raw = String(data.get("value")); const value = raw === "true" ? true : raw === "false" ? false : Number.isNaN(Number(raw)) ? raw : Number(raw); return { planKey: data.get("planKey"), key: data.get("key"), value }; })}>
        <h2 className="font-semibold text-text">Set plan entitlement</h2>
        <select className={input} name="planKey" required>{plans.map((plan) => <option key={plan.key} value={plan.key}>{plan.name} ({plan.key})</option>)}</select><select className={input} name="key" required><option value="">Choose capability or meter</option>{accessDefinitions.map((definition) => <option key={definition.key} value={definition.key}>{definition.name} · {definition.kind}</option>)}</select><input className={input} name="value" placeholder="true or numeric limit" required /><button disabled={saving} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-black">Save entitlement</button>
      </form>
    </div>
    <section className="rounded-xl border border-border bg-surface-raised p-5"><h2 className="font-semibold text-text">Configured plans</h2><div className="mt-4 divide-y divide-border">{plans.map((plan) => <div key={plan.key} className="flex flex-wrap justify-between gap-3 py-3 text-sm"><div><p className="font-medium text-text">{plan.name} · {plan.productKey}</p><p className="text-text-muted">{plan.key} · {entitlements.filter((item) => item.planKey === plan.key).length} entitlements</p></div><div className="text-right text-text-muted"><p>{plan.currency} {plan.amountMinor === null ? "—" : (plan.amountMinor / 100).toFixed(2)} / {plan.interval.toLowerCase()}</p><p>{plan.active ? "Active" : "Draft"} · {plan.paystackPlanCode || "No Paystack code"}</p></div></div>)}</div></section>
  </div>;
}
