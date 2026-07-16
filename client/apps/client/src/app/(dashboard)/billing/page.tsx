import { Badge } from "@/components/ui/badge";
import { fetchBillingSummary, type ProductAccess } from "@/lib/billing";
import { getRustSession } from "@/lib/rust-auth";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Billing and Usage | KasiTek",
};

function productStateLabel(product: ProductAccess) {
  if (!product.hasAccess) return "Upgrade required";
  if (product.subscriptionStatus === "TRIAL") return "Trial";
  if (product.cancelAtPeriodEnd) return "Cancels at period end";
  return "Active";
}

export default async function BillingPage() {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");

  const summary = await fetchBillingSummary().catch(() => null);

  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1200px] space-y-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Billing and usage</h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">
            Review the products enabled for this workspace, their current access state, and the
            usage that will apply to future plans.
          </p>
        </div>

        {!summary ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-5 text-sm text-destructive">
            Billing information is unavailable right now. No product access has been changed.
          </div>
        ) : (
          <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {summary.products.map((product) => (
              <article key={product.key} className="rounded-xl border border-border bg-card p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-foreground">{product.name}</h2>
                    {product.description ? (
                      <p className="mt-1 text-sm text-muted-foreground">{product.description}</p>
                    ) : null}
                  </div>
                  <Badge
                    className={
                      product.hasAccess
                        ? "border-primary/30 bg-primary/10 text-primary"
                        : "border-border bg-secondary text-muted-foreground"
                    }
                  >
                    {productStateLabel(product)}
                  </Badge>
                </div>

                <div className="mt-5 space-y-2 border-t border-border pt-4 text-sm">
                  <p className="text-muted-foreground">
                    Plan: <span className="text-foreground">{product.planName ?? "Not enabled"}</span>
                  </p>
                  {Object.keys(product.usage).length > 0 ? (
                    <div className="space-y-1 text-muted-foreground">
                      <p className="text-foreground">Current month usage</p>
                      {Object.entries(product.usage).map(([metric, quantity]) => (
                        <p key={metric}>
                          {metric}: {quantity}
                        </p>
                      ))}
                    </div>
                  ) : (
                    <p className="text-muted-foreground">Usage metering has not started for this product.</p>
                  )}
                </div>

                {!product.hasAccess ? (
                  <p className="mt-5 rounded-lg border border-border bg-secondary/50 px-3 py-2 text-sm text-muted-foreground">
                    Plans and checkout will appear here when billing is enabled for this workspace.
                  </p>
                ) : null}
              </article>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
