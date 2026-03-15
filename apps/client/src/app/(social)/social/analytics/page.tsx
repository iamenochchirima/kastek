"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function SocialAnalyticsPage() {
  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1400px] space-y-6">
        <div>
          <Badge className="mb-2 border-primary/30 bg-primary/5 text-primary">Analytics</Badge>
          <h1 className="text-3xl font-semibold tracking-tight">Measure what content actually performs.</h1>
          <p className="mt-1 text-muted-foreground">
            Unify engagement, reach, publishing consistency, and per-channel comparisons in one operating view.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {[
            ["Posts Published", "48", "Across all connected channels in the last 30 days"],
            ["Engagement Rate", "6.4%", "Average across Facebook, Instagram, and LinkedIn"],
            ["Top Channel", "Instagram", "Best engagement and saves in the current period"],
            ["Best Time", "17:30", "Highest average interaction window this month"],
          ].map(([label, value, helper]) => (
            <Card key={label}>
              <CardContent className="p-5">
                <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
                <div className="mt-3 text-3xl font-semibold">{value}</div>
                <div className="mt-2 text-sm text-muted-foreground">{helper}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Channel Snapshot</CardTitle>
              <CardDescription>Compare outcomes before diving into individual posts.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {[
                ["Facebook", "12.4k reach", "4.8% engagement"],
                ["Instagram", "9.1k reach", "7.2% engagement"],
                ["LinkedIn", "3.4k reach", "5.1% engagement"],
                ["X", "18.6k impressions", "3.9% engagement"],
              ].map(([name, metricA, metricB]) => (
                <div key={name} className="flex items-center justify-between rounded-md bg-secondary/50 p-4 text-sm">
                  <span className="font-semibold">{name}</span>
                  <span className="text-muted-foreground">{metricA}</span>
                  <span className="text-accent">{metricB}</span>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Insights Queue</CardTitle>
              <CardDescription>AI-generated summaries and recommended next moves.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              {[
                "Carousel posts are outperforming single-image updates by 28% on Instagram.",
                "Short-form updates on X are driving the fastest top-of-funnel engagement.",
                "LinkedIn content performs best on Tuesday and Thursday mornings.",
              ].map((insight) => (
                <div key={insight} className="rounded-md bg-secondary/50 p-4 leading-6">
                  {insight}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
