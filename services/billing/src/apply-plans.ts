import "dotenv/config";
import { createPool } from "./db.js";
import { getActivePlanVersion, getPlanEntitlements, upsertPlan } from "./catalog.js";
import { PLANS } from "./seed-main.js";

const databaseUrl = process.env.BILLING_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("BILLING_DATABASE_URL is required");

const codes = JSON.parse(process.env.BILLING_PLAN_CODES_JSON ?? "{}") as Record<string, string>;
const only = new Set(
  (process.env.BILLING_PLAN_KEYS ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean),
);
const pool = createPool(databaseUrl);

try {
  for (const plan of PLANS) {
    if (plan.product === "agency") continue;
    if (only.size && !only.has(plan.key)) continue;
    const paystackPlanCode = codes[plan.key] ?? null;
    if (plan.amountMinor > 0 && !paystackPlanCode) {
      console.log(`skip ${plan.key}: no Paystack plan code`);
      continue;
    }
    const current = await getActivePlanVersion(pool, plan.key, "ZAR").catch(() => null);
    if (current) {
      const currentEntitlements = await getPlanEntitlements(pool, current.id);
      const desired = [...plan.entitlements]
        .map((item) => ({ key: item.key, value: item.value }))
        .sort((left, right) => left.key.localeCompare(right.key));
      const existing = currentEntitlements
        .map((item) => ({ key: item.key, value: item.value }))
        .sort((left, right) => left.key.localeCompare(right.key));
      const same =
        current.plan_name === plan.name &&
        BigInt(current.amount_minor) === BigInt(plan.amountMinor) &&
        (current.credits_per_period === null
          ? plan.credits === null
          : plan.credits !== null && BigInt(current.credits_per_period) === BigInt(plan.credits)) &&
        current.paystack_plan_code === paystackPlanCode &&
        JSON.stringify(existing) === JSON.stringify(desired);
      if (same) {
        console.log(`skip ${plan.key}: version ${current.version} already matches`);
        continue;
      }
    }
    const result = await upsertPlan(pool, {
      product: plan.product,
      key: plan.key,
      name: plan.name,
      description: plan.description,
      amountMinor: String(plan.amountMinor),
      currency: "ZAR",
      taxInclusive: true,
      taxRateBps: 1_500,
      creditsPerPeriod: plan.credits == null ? null : String(plan.credits),
      paystackPlanCode,
      active: plan.amountMinor === 0 || Boolean(paystackPlanCode),
      entitlements: plan.entitlements.map((item) => ({
        key: item.key,
        value: item.value,
        metadata: {
          ...(item.enforcement ? { enforcement: item.enforcement } : {}),
          ...(item.visible === false ? { visible: false } : {}),
        },
      })),
    });
    console.log(`${plan.key}: version ${result.version} ${result.status}`);
  }
} finally {
  await pool.end();
}
