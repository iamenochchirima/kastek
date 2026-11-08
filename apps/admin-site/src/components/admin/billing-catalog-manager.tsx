"use client";

import { FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import ConfirmModal from "@/components/admin/confirm-modal";
import { Badge } from "@/components/ui/badge";
import { buttonClassName } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

type Product = { key: string; name: string; description: string | null; active: boolean };
type Capability = {
  key: string;
  product: string;
  name: string;
  description: string | null;
  kind: "feature" | "limit" | "meter";
  unit: string | null;
  valueType: "boolean" | "integer" | "decimal" | "string";
  displayGroup: string | null;
  displayOrder: number;
  visibleToCustomer: boolean;
  implementationStatus: "implemented" | "product_pending" | "display_only";
  creditCostPerUnit: string | null;
  creditCostMinimum: string;
  active: boolean;
};
type Entitlement = {
  key: string;
  value: unknown;
  metadata: Record<string, unknown>;
  kind?: "feature" | "limit" | "meter";
  name?: string;
  description?: string | null;
};
type Plan = {
  key: string;
  name: string;
  description: string | null;
  product: string;
  version: number;
  versionId: string;
  status: string;
  currency: string;
  amountMinor: string;
  creditsPerPeriod: string | null;
  checkoutReady: boolean;
};
type Version = Plan & {
  activeSubscriptions?: number;
  paystackPlanCode: string | null;
  entitlements: Entitlement[];
  effectiveFrom: string;
  effectiveTo: string | null;
  notes: string | null;
  taxInclusive: boolean;
  taxRateBps: number;
  planKey: string;
};
type PlanDetail = {
  plan: {
    id: string;
    key: string;
    product_key: string;
    name: string;
    description: string | null;
    status: string;
  };
  versions: Version[];
};

async function mutate(path: string, method: string, body?: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      typeof payload?.error === "string" ? payload.error : "Billing request failed",
    );
  return payload;
}

function money(amountMinor: string | number | null, currency: string) {
  if (amountMinor === null) return "—";
  return new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(Number(amountMinor) / 100);
}

function usd(microUsd: string | null) {
  if (microUsd === null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(microUsd) / 1_000_000);
}

function statusVariant(status: string) {
  if (status === "active") return "success" as const;
  if (status === "scheduled") return "info" as const;
  if (status === "draft") return "attention" as const;
  return "secondary" as const;
}

export function BillingCatalogManager({
  products,
  capabilities,
  plans,
  versions,
  entitlements,
  accessDefinitions,
}: {
  products: Product[];
  capabilities: Capability[];
  plans: Plan[];
  versions: Version[];
  entitlements: Entitlement[];
  accessDefinitions: Array<{ key: string; name: string; kind: string }>;
}) {
  const router = useRouter();
  const [tab, setTab] = useState("plans");
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  function fail(reason: unknown) {
    setError(reason instanceof Error ? reason.message : "Update failed");
  }

  async function loadPlan(planKey: string) {
    setSelectedPlan(planKey);
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/billing/plans/${encodeURIComponent(planKey)}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(payload?.error ?? "Plan could not be loaded");
      setDetail(payload as PlanDetail);
    } catch (reason) {
      fail(reason);
    } finally {
      setLoading(false);
    }
  }

  async function refreshPlan(planKey: string) {
    await loadPlan(planKey);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {error ? (
        <p role="alert" className="rounded-md border border-status-danger/25 bg-status-danger-soft p-3 text-sm text-status-danger">
          {error}
        </p>
      ) : null}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="plans">Plans</TabsTrigger>
          <TabsTrigger value="capabilities">Capabilities</TabsTrigger>
          <TabsTrigger value="offerings">Offerings</TabsTrigger>
        </TabsList>

        <TabsContent value="plans" className="mt-4 space-y-6">
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <section className="v-card p-[var(--density-card-padding)]">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">Plans</h2>
                  <p className="mt-1 text-xs text-muted-foreground">{plans.length} configured</p>
                </div>
              </div>
              <div className="mt-4 divide-y divide-line">
                {plans.map((plan) => {
                  const planVersions = versions.filter((version) => version.planKey === plan.key);
                  const latest = planVersions[0];
                  return (
                    <button
                      key={plan.key}
                      type="button"
                      onClick={() => loadPlan(plan.key)}
                      className={`flex w-full flex-wrap items-start justify-between gap-3 py-3 text-left transition-colors hover:text-foreground ${selectedPlan === plan.key ? "text-foreground" : "text-foreground/85"}`}
                    >
                      <div>
                        <p className="font-medium text-foreground">{plan.name}</p>
                        <p className="text-xs text-muted-foreground">{plan.product} · {plan.key}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm text-foreground">{money(plan.amountMinor, plan.currency)} / month</p>
                        <div className="mt-1 flex items-center justify-end gap-1.5">
                          <Badge variant={statusVariant(latest?.status ?? "draft")}>{latest?.status ?? "draft"}</Badge>
                          <Badge variant="outline">v{latest?.version ?? plan.version}</Badge>
                        </div>
                      </div>
                    </button>
                  );
                })}
                {!plans.length ? <p className="py-6 text-sm text-muted-foreground">No plans yet</p> : null}
              </div>
            </section>

            <div className="space-y-6">
              {detail ? (
                <PlanEditor
                  key={detail.plan.key}
                  detail={detail}
                  capabilities={capabilities}
                  products={products}
                  onRefresh={() => refreshPlan(detail.plan.key)}
                  onError={fail}
                />
              ) : (
                <section className="v-card p-[var(--density-card-padding)]">
                  <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">Plan detail</h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {loading ? "Loading plan..." : "Select a plan to edit its versions and entitlements."}
                  </p>
                </section>
              )}
              <NewPlanForm
                products={products}
                onCreated={(planKey) => refreshPlan(planKey)}
                onError={fail}
              />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="capabilities" className="mt-4">
          <CapabilityManager
            products={products}
            capabilities={capabilities}
            accessDefinitions={accessDefinitions}
            entitlements={entitlements}
            onSaved={() => router.refresh()}
            onError={fail}
          />
        </TabsContent>

        <TabsContent value="offerings" className="mt-4">
          <ProductManager products={products} onSaved={() => router.refresh()} onError={fail} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PlanEditor({
  detail,
  capabilities,
  products,
  onRefresh,
  onError,
}: {
  detail: PlanDetail;
  capabilities: Capability[];
  products: Product[];
  onRefresh: () => void;
  onError: (reason: unknown) => void;
}) {
  const [selectedVersionId, setSelectedVersionId] = useState(
    detail.versions.find((version) => version.status === "draft")?.versionId ??
      detail.versions[0]?.versionId ??
      null,
  );
  const [saving, setSaving] = useState(false);
  const [retireOpen, setRetireOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  const selected = detail.versions.find((version) => version.versionId === selectedVersionId) ?? detail.versions[0];
  const editable = selected?.status === "draft" || selected?.status === "scheduled";
  const product = products.find((item) => item.key === detail.plan.product_key);

  async function run(action: () => Promise<unknown>) {
    setSaving(true);
    try {
      await action();
      onRefresh();
    } catch (reason) {
      onError(reason);
    } finally {
      setSaving(false);
    }
  }

  async function saveVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const amount = Number(data.get("amount"));
    const credits = String(data.get("credits") ?? "").trim();
    await run(() =>
      mutate(`/api/billing/plan-versions/${encodeURIComponent(selected.versionId)}`, "PUT", {
        amountMinor: String(Math.round(amount * 100)),
        currency: String(data.get("currency") ?? selected.currency).toUpperCase(),
        taxInclusive: data.get("taxInclusive") === "on",
        taxRateBps: Math.round(Number(data.get("taxRateBps") ?? 0)),
        creditsPerPeriod: credits ? String(Math.round(Number(credits) * 1_000_000)) : null,
        paystackPlanCode: String(data.get("paystackPlanCode") ?? "").trim() || null,
        notes: String(data.get("notes") ?? "").trim() || null,
      }),
    );
  }

  async function createVersion() {
    await run(() => mutate(`/api/billing/plans/${encodeURIComponent(detail.plan.key)}/versions`, "POST", {}));
  }

  async function publish() {
    if (!selected) return;
    await run(() => mutate(`/api/billing/plan-versions/${encodeURIComponent(selected.versionId)}/publish`, "POST", {}));
  }

  async function schedule() {
    if (!selected || !scheduleAt) return;
    await run(() =>
      mutate(`/api/billing/plan-versions/${encodeURIComponent(selected.versionId)}/schedule`, "POST", {
        effectiveFrom: new Date(scheduleAt).toISOString(),
      }),
    );
  }

  async function retire() {
    if (!selected) return;
    setRetireOpen(false);
    await run(() => mutate(`/api/billing/plan-versions/${encodeURIComponent(selected.versionId)}/retire`, "POST", {}));
  }

  async function clonePlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await run(() =>
      mutate(`/api/billing/plans/${encodeURIComponent(detail.plan.key)}/clone`, "POST", {
        key: String(data.get("key") ?? ""),
        name: String(data.get("name") ?? ""),
      }),
    );
  }

  return (
    <section className="v-card space-y-5 p-[var(--density-card-padding)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">{detail.plan.name}</h2>
            <Badge variant="outline">{product?.name ?? detail.plan.product_key}</Badge>
            <Badge variant={detail.plan.status === "active" ? "success" : "secondary"}>{detail.plan.status}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{detail.plan.key}</p>
          {detail.plan.description ? <p className="mt-2 max-w-xl text-sm text-muted-foreground">{detail.plan.description}</p> : null}
        </div>
        <button type="button" onClick={createVersion} disabled={saving} className={buttonClassName({ variant: "outline", size: "sm" })}>
          New version
        </button>
      </div>

      <div className="space-y-2">
        {detail.versions.map((version) => (
          <button
            key={version.versionId}
            type="button"
            onClick={() => setSelectedVersionId(version.versionId)}
            className={`flex w-full flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${selected?.versionId === version.versionId ? "border-primary/40 bg-primary/5" : "border-line bg-background/30 hover:bg-accent/40"}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">Version {version.version}</span>
              <Badge variant={statusVariant(version.status)}>{version.status}</Badge>
              <span className="text-muted-foreground">{money(version.amountMinor, version.currency)} / month</span>
              <span className="text-muted-foreground">{usd(version.creditsPerPeriod)} AI</span>
            </div>
            <span className="text-xs text-muted-foreground">
              {version.activeSubscriptions ?? 0} active · {new Date(version.effectiveFrom).toLocaleDateString("en-ZA")}
            </span>
          </button>
        ))}
      </div>

      {selected ? (
        <>
          <div className="rounded-lg border border-line bg-secondary/20 p-4">
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Customer preview</p>
            <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-foreground">{detail.plan.name}</h3>
                {detail.plan.description ? <p className="mt-1 max-w-xl text-sm text-muted-foreground">{detail.plan.description}</p> : null}
              </div>
              <p className="text-lg font-semibold text-foreground">{money(selected.amountMinor, selected.currency)} / month</p>
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Included</p>
                <ul className="mt-2 space-y-1 text-sm text-foreground">
                  {selected.entitlements.filter((item) => item.kind === "feature" && item.value === true).map((item) => <li key={item.key}>{item.name}</li>)}
                </ul>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Limits and usage</p>
                <ul className="mt-2 space-y-1 text-sm text-foreground">
                  <li>AI usage: {usd(selected.creditsPerPeriod)}</li>
                  {selected.entitlements.filter((item) => item.kind === "limit" && Number(item.value) > 0).map((item) => <li key={item.key}>{item.name}: {String(item.value)}</li>)}
                </ul>
              </div>
            </div>
          </div>

          <form key={selected.versionId} className="grid gap-3 sm:grid-cols-2" onSubmit={saveVersion}>
            <FormField id="version-currency" label="Currency">
              <Input id="version-currency" name="currency" defaultValue={selected.currency} maxLength={3} disabled={!editable} />
            </FormField>
            <FormField id="version-amount" label="Price per month" hint="Major units, excluding any configured VAT treatment.">
              <Input id="version-amount" name="amount" type="number" min="0" step="0.01" defaultValue={(Number(selected.amountMinor) / 100).toFixed(2)} disabled={!editable} />
            </FormField>
            <FormField id="version-credits" label="Monthly AI usage (USD)" hint="Converted to micro-USD when saved.">
              <Input id="version-credits" name="credits" type="number" min="0" step="0.01" defaultValue={selected.creditsPerPeriod === null ? "" : (Number(selected.creditsPerPeriod) / 1_000_000).toFixed(2)} disabled={!editable} />
            </FormField>
            <FormField id="version-tax-rate" label="VAT rate (bps)">
              <Input id="version-tax-rate" name="taxRateBps" type="number" min="0" max="10000" defaultValue={selected.taxRateBps} disabled={!editable} />
            </FormField>
            <FormField id="version-paystack" label="Paystack plan code" hint={editable ? "Required to publish a paid plan. A price change requires a new Paystack plan." : undefined}>
              <Input id="version-paystack" name="paystackPlanCode" defaultValue={selected.paystackPlanCode ?? ""} disabled={!editable} />
            </FormField>
            <label className="flex items-center gap-2 pt-6 text-sm text-muted-foreground">
              <Checkbox name="taxInclusive" defaultChecked={selected.taxInclusive} disabled={!editable} /> Price includes VAT
            </label>
            <div className="sm:col-span-2">
              <FormField id="version-notes" label="Notes">
                <Textarea id="version-notes" name="notes" defaultValue={selected.notes ?? ""} disabled={!editable} />
              </FormField>
            </div>
            <div className="sm:col-span-2">
              <FormField id="version-schedule" label="Schedule effective date" hint="Publishes the version when the date passes.">
                <Input
                  id="version-schedule"
                  type="datetime-local"
                  value={scheduleAt}
                  disabled={!editable}
                  onChange={(event) => setScheduleAt(event.target.value)}
                />
              </FormField>
            </div>
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              {editable ? (
                <button type="submit" disabled={saving} className={buttonClassName({ size: "sm" })}>
                  {saving ? "Saving..." : "Save version"}
                </button>
              ) : null}
              {editable && scheduleAt ? (
                <button type="button" onClick={schedule} disabled={saving} className={buttonClassName({ variant: "outline", size: "sm" })}>
                  Schedule version
                </button>
              ) : null}
              {editable ? (
                <button type="button" onClick={publish} disabled={saving} className={buttonClassName({ variant: "secondary", size: "sm" })}>
                  Publish version
                </button>
              ) : null}
              {selected.status === "active" ? (
                <button type="button" onClick={() => setRetireOpen(true)} disabled={saving} className={buttonClassName({ variant: "destructive", size: "sm" })}>
                  Retire version
                </button>
              ) : null}
            </div>
          </form>

          <EntitlementMatrix
            key={selected.versionId}
            version={selected}
            capabilities={capabilities.filter((capability) => capability.product === detail.plan.product_key)}
            editable={editable}
            saving={saving}
            onSave={async (rows) => {
              await run(() =>
                mutate(`/api/billing/plan-versions/${encodeURIComponent(selected.versionId)}/entitlements`, "PUT", { entitlements: rows }),
              );
            }}
          />

          <form className="flex flex-wrap items-end gap-3 border-t border-line pt-4" onSubmit={clonePlan}>
            <FormField id="clone-key" label="Clone as key">
              <Input id="clone-key" name="key" placeholder={`${detail.plan.key}-copy`} required />
            </FormField>
            <FormField id="clone-name" label="Clone name">
              <Input id="clone-name" name="name" placeholder={`${detail.plan.name} copy`} required />
            </FormField>
            <button type="submit" disabled={saving} className={buttonClassName({ variant: "outline", size: "sm" })}>Clone plan</button>
          </form>

          <ConfirmModal
            open={retireOpen}
            title="Retire this version?"
            message="New checkouts will no longer use it. Existing subscribers stay on this version."
            confirmLabel="Retire"
            loadingLabel="Retiring..."
            loading={saving}
            confirmVariant="destructive"
            onConfirm={retire}
            onCancel={() => setRetireOpen(false)}
          />
        </>
      ) : null}
    </section>
  );
}

type EntitlementRow = {
  key: string;
  enabled: boolean;
  value: string;
  enforcement: "hard" | "display_only";
  visible: boolean;
};

function EntitlementMatrix({
  version,
  capabilities,
  editable,
  saving,
  onSave,
}: {
  version: Version;
  capabilities: Capability[];
  editable: boolean;
  saving: boolean;
  onSave: (rows: Array<{ key: string; value: unknown; metadata: Record<string, unknown> }>) => Promise<void>;
}) {
  const [rows, setRows] = useState<EntitlementRow[]>(() => {
    const existing = new Map(version.entitlements.map((item) => [item.key, item]));
    return capabilities.map((capability) => {
      const entitlement = existing.get(capability.key);
      const enforcement =
        entitlement?.metadata?.enforcement === "display_only" ||
        capability.implementationStatus !== "implemented"
          ? "display_only"
          : "hard";
      return {
        key: capability.key,
        enabled: Boolean(entitlement),
        value:
          entitlement === undefined
            ? capability.kind === "feature"
              ? "false"
              : "0"
            : typeof entitlement.value === "string"
              ? entitlement.value
              : JSON.stringify(entitlement.value),
        enforcement,
        visible: capability.visibleToCustomer,
      };
    });
  });

  const groups = useMemo(() => {
    const map = new Map<string, Array<{ capability: Capability; row: EntitlementRow }>>();
    for (const capability of capabilities) {
      const row = rows.find((item) => item.key === capability.key);
      if (!row) continue;
      const group = capability.displayGroup ?? capability.kind;
      map.set(group, [...(map.get(group) ?? []), { capability, row }]);
    }
    return [...map.entries()].sort((left, right) => left[0].localeCompare(right[0]));
  }, [capabilities, rows]);

  function update(key: string, patch: Partial<EntitlementRow>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  async function save() {
    await onSave(
      rows
        .filter((row) => row.enabled)
        .map((row) => {
          const capability = capabilities.find((item) => item.key === row.key);
          let value: unknown = row.value;
          if (capability?.kind === "feature" || capability?.valueType === "boolean")
            value = row.value === "true";
          else if (capability?.valueType === "integer" || capability?.valueType === "decimal")
            value = Number(row.value);
          return {
            key: row.key,
            value,
            metadata:
              capability?.kind === "limit" ? { enforcement: row.enforcement } : {},
          };
        }),
    );
  }

  return (
    <div className="space-y-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Entitlements</h3>
          <p className="mt-1 text-xs text-muted-foreground">Capabilities and limits for version {version.version}.</p>
        </div>
        {editable ? (
          <button type="button" onClick={save} disabled={saving} className={buttonClassName({ size: "sm" })}>
            {saving ? "Saving..." : "Save entitlements"}
          </button>
        ) : null}
      </div>

      {groups.map(([group, items]) => (
        <div key={group} className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">{group}</p>
          <div className="divide-y divide-line rounded-lg border border-line">
            {items.map(({ capability, row }) => (
              <div key={capability.key} className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_150px_130px] sm:items-center">
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox
                    checked={row.enabled}
                    disabled={!editable}
                    onChange={(event) => update(capability.key, { enabled: event.target.checked })}
                  />
                  <span>
                    <span className="font-medium text-foreground">{capability.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{capability.key}</span>
                    {capability.description ? <span className="mt-0.5 block text-xs text-muted-foreground">{capability.description}</span> : null}
                  </span>
                </label>
                <div>
                  {capability.kind === "feature" || capability.valueType === "boolean" ? (
                    <Select
                      aria-label={`${capability.name} value`}
                      value={row.value === "true" ? "true" : "false"}
                      disabled={!editable || !row.enabled}
                      onChange={(event) => update(capability.key, { value: event.target.value })}
                    >
                      <option value="true">Included</option>
                      <option value="false">Not included</option>
                    </Select>
                  ) : (
                    <Input
                      aria-label={`${capability.name} value`}
                      type="number"
                      value={row.value}
                      disabled={!editable || !row.enabled}
                      onChange={(event) => update(capability.key, { value: event.target.value })}
                    />
                  )}
                </div>
                <div>
                  {capability.kind === "limit" ? (
                    <Select
                      aria-label={`${capability.name} enforcement`}
                      value={row.enforcement}
                      disabled={!editable || !row.enabled}
                      onChange={(event) =>
                        update(capability.key, {
                          enforcement: event.target.value === "hard" ? "hard" : "display_only",
                        })
                      }
                    >
                      <option value="hard">Enforced</option>
                      <option value="display_only">Display only</option>
                    </Select>
                  ) : capability.unit ? (
                    <span className="text-xs text-muted-foreground">{capability.unit}</span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function NewPlanForm({
  products,
  onCreated,
  onError,
}: {
  products: Product[];
  onCreated: (planKey: string) => void;
  onError: (reason: unknown) => void;
}) {
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setSaving(true);
    try {
      const payload = (await mutate("/api/billing/plans", "POST", {
        product: data.get("product"),
        key: data.get("key"),
        name: data.get("name"),
        description: String(data.get("description") ?? "").trim() || null,
        amountMinor: String(Math.round(Number(data.get("amount")) * 100)),
        currency: String(data.get("currency") ?? "ZAR").toUpperCase(),
        taxInclusive: true,
        taxRateBps: 1500,
        creditsPerPeriod: String(Math.round(Number(data.get("credits")) * 1_000_000)),
        paystackPlanCode: String(data.get("paystackPlanCode") ?? "").trim() || null,
        entitlements: [],
      })) as { key: string };
      form.reset();
      onCreated(payload.key);
    } catch (reason) {
      onError(reason);
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="v-card space-y-3 p-[var(--density-card-padding)]" onSubmit={submit}>
      <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">New plan</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="new-plan-product" label="Product" required>
          <Select id="new-plan-product" name="product" required defaultValue="">
            <option value="" disabled>Select product</option>
            {products.map((product) => <option key={product.key} value={product.key}>{product.name}</option>)}
          </Select>
        </FormField>
        <FormField id="new-plan-key" label="Plan key" required><Input id="new-plan-key" name="key" placeholder="growth-entry" required /></FormField>
        <FormField id="new-plan-name" label="Name" required><Input id="new-plan-name" name="name" placeholder="Growth" required /></FormField>
        <FormField id="new-plan-currency" label="Currency" required><Input id="new-plan-currency" name="currency" defaultValue="ZAR" maxLength={3} required /></FormField>
        <FormField id="new-plan-amount" label="Price per month" required><Input id="new-plan-amount" name="amount" type="number" min="0" step="0.01" required /></FormField>
        <FormField id="new-plan-credits" label="Monthly AI usage (USD)" required><Input id="new-plan-credits" name="credits" type="number" min="0" step="0.01" defaultValue="0" required /></FormField>
        <FormField id="new-plan-paystack" label="Paystack plan code"><Input id="new-plan-paystack" name="paystackPlanCode" placeholder="PLN_..." /></FormField>
        <div className="sm:col-span-2"><FormField id="new-plan-description" label="Description"><Textarea id="new-plan-description" name="description" /></FormField></div>
      </div>
      <button type="submit" disabled={saving} className={buttonClassName({ size: "sm" })}>{saving ? "Creating..." : "Create draft"}</button>
    </form>
  );
}

function CapabilityManager({
  products,
  capabilities,
  accessDefinitions,
  entitlements,
  onSaved,
  onError,
}: {
  products: Product[];
  capabilities: Capability[];
  accessDefinitions: Array<{ key: string; name: string; kind: string }>;
  entitlements: Entitlement[];
  onSaved: () => void;
  onError: (reason: unknown) => void;
}) {
  const [editing, setEditing] = useState<Capability | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setSaving(true);
    try {
      await mutate("/api/billing/capabilities", "POST", {
        key: data.get("key"),
        product: data.get("product"),
        name: data.get("name"),
        description: String(data.get("description") ?? "").trim() || null,
        kind: data.get("kind"),
        unit: String(data.get("unit") ?? "").trim() || null,
        valueType: data.get("valueType"),
        displayGroup: String(data.get("displayGroup") ?? "").trim() || null,
        displayOrder: Number(data.get("displayOrder") ?? 0),
        visibleToCustomer: data.get("visibleToCustomer") === "on",
        implementationStatus: data.get("implementationStatus"),
        creditCostPerUnit: String(data.get("creditCostPerUnit") ?? "").trim() || null,
        creditCostMinimum: String(data.get("creditCostMinimum") ?? "0").trim() || "0",
        active: data.get("active") === "on",
      });
      setEditing(null);
      form.reset();
      onSaved();
    } catch (reason) {
      onError(reason);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <section className="v-card p-[var(--density-card-padding)]">
        <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">Capabilities</h2>
        <p className="mt-1 text-xs text-muted-foreground">{capabilities.length} registered · {accessDefinitions.length} access definitions</p>
        <div className="mt-4 divide-y divide-line">
          {capabilities.map((capability) => (
            <button key={capability.key} type="button" onClick={() => setEditing(capability)} className="flex w-full flex-wrap items-start justify-between gap-3 py-3 text-left hover:text-foreground">
              <div>
                <p className="font-medium text-foreground">{capability.name}</p>
                <p className="text-xs text-muted-foreground">{capability.product} · {capability.key} · {capability.kind}</p>
              </div>
              <div className="flex items-center gap-1.5">
                <Badge variant={capability.implementationStatus === "implemented" ? "success" : "attention"}>{capability.implementationStatus.replaceAll("_", " ")}</Badge>
                {!capability.active ? <Badge variant="secondary">inactive</Badge> : null}
              </div>
            </button>
          ))}
        </div>
      </section>

      <form key={editing?.key ?? "new"} className="v-card space-y-3 p-[var(--density-card-padding)]" onSubmit={submit}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">{editing ? "Edit capability" : "New capability"}</h2>
          {editing ? <button type="button" onClick={() => setEditing(null)} className={buttonClassName({ variant: "ghost", size: "sm" })}>New</button> : null}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField id="capability-key" label="Key" required><Input id="capability-key" name="key" defaultValue={editing?.key ?? ""} readOnly={Boolean(editing)} required /></FormField>
          {editing ? <input type="hidden" name="product" value={editing.product} /> : null}
          <FormField id="capability-product" label="Product" required>
            <Select id="capability-product" name={editing ? undefined : "product"} defaultValue={editing?.product ?? ""} required disabled={Boolean(editing)}>
              <option value="" disabled>Select product</option>
              {products.map((product) => <option key={product.key} value={product.key}>{product.name}</option>)}
            </Select>
          </FormField>
          <FormField id="capability-name" label="Name" required><Input id="capability-name" name="name" defaultValue={editing?.name ?? ""} required /></FormField>
          <FormField id="capability-kind" label="Kind" required>
            <Select id="capability-kind" name="kind" defaultValue={editing?.kind ?? "feature"} required>
              <option value="feature">Feature</option>
              <option value="limit">Limit</option>
              <option value="meter">Meter</option>
            </Select>
          </FormField>
          <FormField id="capability-value-type" label="Value type">
            <Select id="capability-value-type" name="valueType" defaultValue={editing?.valueType ?? "boolean"}>
              <option value="boolean">Boolean</option>
              <option value="integer">Integer</option>
              <option value="decimal">Decimal</option>
              <option value="string">String</option>
            </Select>
          </FormField>
          <FormField id="capability-implementation" label="Implementation">
            <Select id="capability-implementation" name="implementationStatus" defaultValue={editing?.implementationStatus ?? "implemented"}>
              <option value="implemented">Implemented</option>
              <option value="product_pending">Product pending</option>
              <option value="display_only">Display only</option>
            </Select>
          </FormField>
          <FormField id="capability-unit" label="Unit"><Input id="capability-unit" name="unit" defaultValue={editing?.unit ?? ""} placeholder="seats" /></FormField>
          <FormField id="capability-group" label="Display group"><Input id="capability-group" name="displayGroup" defaultValue={editing?.displayGroup ?? ""} placeholder="Features" /></FormField>
          <FormField id="capability-order" label="Display order"><Input id="capability-order" name="displayOrder" type="number" defaultValue={editing?.displayOrder ?? 0} /></FormField>
          <FormField id="capability-credit-cost" label="Credit cost / unit"><Input id="capability-credit-cost" name="creditCostPerUnit" defaultValue={editing?.creditCostPerUnit ?? ""} /></FormField>
          <FormField id="capability-credit-min" label="Minimum credit cost"><Input id="capability-credit-min" name="creditCostMinimum" defaultValue={editing?.creditCostMinimum ?? "0"} /></FormField>
          <div className="sm:col-span-2"><FormField id="capability-description" label="Description"><Textarea id="capability-description" name="description" defaultValue={editing?.description ?? ""} /></FormField></div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground"><Checkbox name="visibleToCustomer" defaultChecked={editing?.visibleToCustomer ?? true} /> Visible to customers</label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground"><Checkbox name="active" defaultChecked={editing?.active ?? true} /> Active</label>
        </div>
        <p className="text-xs text-muted-foreground">{entitlements.filter((item) => item.key === editing?.key).length} plan versions use this capability.</p>
        <button type="submit" disabled={saving} className={buttonClassName({ size: "sm" })}>{saving ? "Saving..." : "Save capability"}</button>
      </form>
    </div>
  );
}

function ProductManager({
  products,
  onSaved,
  onError,
}: {
  products: Product[];
  onSaved: () => void;
  onError: (reason: unknown) => void;
}) {
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setSaving(true);
    try {
      await mutate("/api/billing/products", "POST", {
        key: data.get("key"),
        name: data.get("name"),
        description: String(data.get("description") ?? "").trim() || null,
        active: data.get("active") === "on",
      });
      form.reset();
      onSaved();
    } catch (reason) {
      onError(reason);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <section className="v-card p-[var(--density-card-padding)]">
        <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">Offerings</h2>
        <div className="mt-4 divide-y divide-line">
          {products.map((product) => (
            <div key={product.key} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <div><p className="font-medium text-foreground">{product.name}</p><p className="text-xs text-muted-foreground">{product.key}</p></div>
              <Badge variant={product.active ? "success" : "secondary"}>{product.active ? "active" : "inactive"}</Badge>
            </div>
          ))}
        </div>
      </section>
      <form className="v-card space-y-3 p-[var(--density-card-padding)]" onSubmit={submit}>
        <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">Create or update offering</h2>
        <FormField id="product-key" label="Key" required><Input id="product-key" name="key" placeholder="growth" required /></FormField>
        <FormField id="product-name" label="Name" required><Input id="product-name" name="name" placeholder="Growth" required /></FormField>
        <FormField id="product-description" label="Description"><Textarea id="product-description" name="description" /></FormField>
        <label className="flex items-center gap-2 text-sm text-muted-foreground"><Checkbox name="active" defaultChecked /> Active</label>
        <button type="submit" disabled={saving} className={buttonClassName({ size: "sm" })}>{saving ? "Saving..." : "Save offering"}</button>
      </form>
    </div>
  );
}
