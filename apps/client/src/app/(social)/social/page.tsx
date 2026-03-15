"use client";

import { BarChart3, CalendarRange, Layers3, Sparkles, Wand2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";

const statCards = [
  { label: "Scheduled This Week", value: "12", sublabel: "3 include WhatsApp Status", icon: CalendarRange, trend: "+4 vs last week" },
  { label: "Connected Channels", value: "5", sublabel: "FB, IG, LinkedIn, X, Status", icon: Layers3, trend: "1 pending setup" },
  { label: "Drafts Waiting", value: "8", sublabel: "AI-generated post ideas", icon: Wand2, trend: "3 need approval" },
  { label: "Reach Growth", value: "+18%", sublabel: "Across the last 30 days", icon: BarChart3, trend: "Best on Instagram" },
];

const plannerItems = [
  { title: "Sunday trading reminder", channels: "Facebook, Instagram, LinkedIn", day: "Mon" },
  { title: "Customer testimonial clip", channels: "Instagram, X", day: "Wed" },
  { title: "Weekend promo teaser", channels: "Facebook, Instagram, WhatsApp Status", day: "Fri" },
];

export default function SocialOverviewPage() {
  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Badge className="mb-2 border-primary/30 bg-primary/5 text-primary">KasiSocial</Badge>
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">
              Standalone social publishing for the KasiTek stack.
            </h1>
            <p className="mt-1 max-w-2xl text-muted-foreground">
              Plan your month, write with AI, publish across channels, and measure what performs
              best from one dedicated workspace.
            </p>
          </div>
          <Link href="/social/posts" className="no-underline">
            <Button className="gap-2">
              <Sparkles className="h-4 w-4" />
              New AI Draft
            </Button>
          </Link>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {statCards.map((stat) => (
            <Card key={stat.label}>
              <CardContent className="p-5">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">{stat.label}</p>
                    <p className="text-3xl font-semibold text-foreground">{stat.value}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{stat.sublabel}</p>
                  </div>
                  <div className="rounded-md bg-primary/10 p-2">
                    <stat.icon className="h-5 w-5 text-primary" />
                  </div>
                </div>
                <p className="mt-3 text-xs text-accent">{stat.trend}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.2fr)_380px]">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <div>
                <CardTitle className="text-base">This Week&apos;s Planner</CardTitle>
                <CardDescription>Suggested publishing queue across your core channels.</CardDescription>
              </div>
              <Link href="/social/calendar" className="no-underline">
                <Button variant="link" className="p-0">Open calendar</Button>
              </Link>
            </CardHeader>
            <CardContent className="space-y-3">
              {plannerItems.map((item) => (
                <div key={item.title} className="flex items-center justify-between rounded-md bg-secondary/50 p-4">
                  <div>
                    <p className="text-sm font-medium text-foreground">{item.title}</p>
                    <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{item.channels}</p>
                  </div>
                  <Badge className="border-accent/30 bg-accent/10 text-accent">{item.day}</Badge>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Implementation Focus</CardTitle>
              <CardDescription>Priority layers for turning KasiSocial into a real product.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {[
                "Channel auth and connection management",
                "AI composer with business voice controls",
                "Calendar scheduling and publish jobs",
                "Per-channel analytics snapshots",
              ].map((item) => (
                <div key={item} className="rounded-md bg-secondary/50 p-4 text-sm text-muted-foreground">
                  {item}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
