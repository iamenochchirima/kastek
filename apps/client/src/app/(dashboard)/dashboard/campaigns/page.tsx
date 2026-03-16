"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import Link from "next/link";
import { Pause, Plus, Search, Zap } from "lucide-react";

const campaigns = [
  { id: 1, name: "Spring Sale 2024", status: "active", template: "Flash Sale Alert", audience: 2847, sent: 2682, delivered: 2534, read: 1876, startDate: "Feb 1, 2024", progress: 94 },
  { id: 2, name: "Welcome Series - Day 1", status: "active", template: "Welcome Message", audience: 1234, sent: 1189, delivered: 1145, read: 987, startDate: "Jan 1, 2024", progress: 100 },
  { id: 3, name: "Re-engagement Campaign", status: "paused", template: "Feedback Request", audience: 567, sent: 234, delivered: 221, read: 145, startDate: "Feb 5, 2024", progress: 41 },
];

export default function DashboardCampaignsPage() {
  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1400px] space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Campaigns</h1>
            <p className="mt-1 text-muted-foreground">Launch and monitor your WhatsApp marketing campaigns.</p>
          </div>
          <Link href="/dashboard/campaigns/create" className="no-underline"><Button><Plus className="h-4 w-4" />Create Campaign</Button></Link>
        </div>
        <div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input placeholder="Search campaigns..." className="pl-9" /></div>
        <div className="space-y-4">
          {campaigns.map((campaign) => (
            <Card key={campaign.id}><CardContent className="space-y-4 p-5"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><h3 className="text-lg font-semibold">{campaign.name}</h3><p className="text-sm text-muted-foreground">Template: {campaign.template}</p></div>{campaign.status === "active" ? <Badge className="border-accent/30 bg-accent/10 text-accent"><Zap className="h-3 w-3" />Active</Badge> : <Badge className="border-primary/30 bg-primary/10 text-primary"><Pause className="h-3 w-3" />Paused</Badge>}</div><div className="grid grid-cols-2 gap-3 sm:grid-cols-5 text-sm"><div className="rounded-lg bg-secondary/50 p-3"><div className="text-muted-foreground">Audience</div><div className="mt-1 font-semibold">{campaign.audience.toLocaleString()}</div></div><div className="rounded-lg bg-secondary/50 p-3"><div className="text-muted-foreground">Sent</div><div className="mt-1 font-semibold">{campaign.sent.toLocaleString()}</div></div><div className="rounded-lg bg-secondary/50 p-3"><div className="text-muted-foreground">Delivered</div><div className="mt-1 font-semibold">{campaign.delivered.toLocaleString()}</div></div><div className="rounded-lg bg-secondary/50 p-3"><div className="text-muted-foreground">Read</div><div className="mt-1 font-semibold">{campaign.read.toLocaleString()}</div></div><div className="rounded-lg bg-secondary/50 p-3"><div className="text-muted-foreground">Start Date</div><div className="mt-1 font-semibold">{campaign.startDate}</div></div></div><div className="space-y-2"><div className="flex items-center justify-between text-sm"><span className="text-muted-foreground">Progress</span><span className="font-medium">{campaign.progress}%</span></div><Progress value={campaign.progress} /></div></CardContent></Card>
          ))}
        </div>
      </div>
    </div>
  );
}
