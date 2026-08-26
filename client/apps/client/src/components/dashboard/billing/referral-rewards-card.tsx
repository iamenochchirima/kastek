"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ReferralSummary } from "@/lib/billing";
import { Check, Clock3, Copy, Users } from "lucide-react";
import { toast } from "sonner";

function formatStatus(value: string) {
  return value.replaceAll("_", " ").toLowerCase().replace(/^\w/, (letter) => letter.toUpperCase());
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleDateString("en-ZA", { dateStyle: "medium" }) : "—";
}

export function ReferralRewardsCard({ referral }: { referral: ReferralSummary | null }) {
  if (!referral) return null;
  const shareUrl = referral.shareUrl;
  const codeDisabled = referral.status !== "ACTIVE";

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success("Referral link copied");
    } catch {
      toast.error("Unable to copy referral link");
    }
  }

  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-[var(--shadow-panel)] sm:p-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-foreground">Referral rewards</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Earn {referral.referrerRewardCredits.toLocaleString()} credits for each paying referral.
          </p>
        </div>
        <div className="rounded-lg border border-primary/20 bg-primary/10 px-3 py-2 text-right">
          <p className="text-xs text-muted-foreground">New workspace</p>
          <p className="font-semibold text-primary">+{referral.refereeRewardCredits.toLocaleString()} credits</p>
        </div>
      </div>

      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <Input readOnly value={referral.shareUrl} aria-label="Referral link" className="min-w-0 font-mono text-xs" />
        <Button type="button" variant="outline" onClick={copyLink} className="shrink-0" disabled={codeDisabled}>
          <Copy className="mr-2 size-4" />Copy link
        </Button>
      </div>
      {codeDisabled ? <p className="mt-2 text-xs text-destructive">Referral code disabled</p> : null}

      <div className="mt-5 grid gap-3 sm:grid-cols-5">
        <div className="rounded-xl border border-border bg-secondary/20 p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><Clock3 className="size-3.5" />Pending</div>
          <p className="mt-2 text-xl font-semibold text-foreground">{referral.pendingCount.toLocaleString()}</p>
        </div>
        <div className="rounded-xl border border-border bg-secondary/20 p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><Check className="size-3.5" />Rewarded</div>
          <p className="mt-2 text-xl font-semibold text-foreground">{referral.awardedCount.toLocaleString()}</p>
        </div>
        <div className="rounded-xl border border-border bg-secondary/20 p-4">
          <div className="text-xs text-muted-foreground">Expired</div>
          <p className="mt-2 text-xl font-semibold text-foreground">{referral.expiredCount.toLocaleString()}</p>
        </div>
        <div className="rounded-xl border border-border bg-secondary/20 p-4">
          <div className="text-xs text-muted-foreground">Reversed</div>
          <p className="mt-2 text-xl font-semibold text-foreground">{referral.reversedCount.toLocaleString()}</p>
        </div>
        <div className="rounded-xl border border-border bg-secondary/20 p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><Users className="size-3.5" />Attributed</div>
          <p className="mt-2 text-xl font-semibold text-foreground">{referral.attributedCount.toLocaleString()}</p>
        </div>
      </div>

      {referral.recent.length ? (
        <div className="mt-5 border-t border-border pt-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium text-foreground">Recent referrals</h3>
            <span className="text-xs text-muted-foreground">Expires after {referral.rewardExpiryDays} days</span>
          </div>
          <div className="mt-3 divide-y divide-border">
            {referral.recent.slice(0, 4).map((item) => (
              <div key={item.id} className="flex flex-col gap-1 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium text-foreground">{item.refereeOrgName}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{formatDate(item.attributedAt)}</p>
                </div>
                <span className="text-xs text-muted-foreground">{formatStatus(item.status)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
