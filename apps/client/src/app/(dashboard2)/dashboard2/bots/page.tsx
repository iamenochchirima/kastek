"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Bot, MessageSquare, Plus, TrendingUp, Zap } from "lucide-react";

const bots = [
  { id: 1, name: "Customer Support Bot", description: "Handles common customer inquiries and support tickets", status: "active", conversations: 1247, responseRate: 98.5, avgResponseTime: "< 1 min", lastActive: "2 minutes ago", triggers: ["WhatsApp", "Website Chat"], color: "bg-accent" },
  { id: 2, name: "Sales Assistant", description: "Qualifies leads and schedules demos with potential customers", status: "active", conversations: 856, responseRate: 94.2, avgResponseTime: "< 2 min", lastActive: "5 minutes ago", triggers: ["WhatsApp", "SMS"], color: "bg-primary" },
  { id: 3, name: "Order Status Bot", description: "Provides real-time order tracking and shipping updates", status: "paused", conversations: 2341, responseRate: 99.1, avgResponseTime: "< 30 sec", lastActive: "1 hour ago", triggers: ["WhatsApp"], color: "bg-blue-500" },
];

export default function Dashboard2BotsPage() {
  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1400px] space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">My Bots</h1>
            <p className="mt-1 text-muted-foreground">Manage your AI agents and automation workflows.</p>
          </div>
          <Button className="gap-2"><Plus className="h-4 w-4" />Create Bot</Button>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <Card><CardContent className="p-5"><div className="flex items-center justify-between"><div><p className="text-xs uppercase tracking-wider text-muted-foreground">Total Bots</p><p className="mt-1 text-2xl font-semibold">{bots.length}</p></div><Bot className="h-5 w-5 text-primary" /></div></CardContent></Card>
          <Card><CardContent className="p-5"><div className="flex items-center justify-between"><div><p className="text-xs uppercase tracking-wider text-muted-foreground">Active</p><p className="mt-1 text-2xl font-semibold">{bots.filter((bot) => bot.status === "active").length}</p></div><Zap className="h-5 w-5 text-accent" /></div></CardContent></Card>
          <Card><CardContent className="p-5"><div className="flex items-center justify-between"><div><p className="text-xs uppercase tracking-wider text-muted-foreground">Total Conversations</p><p className="mt-1 text-2xl font-semibold">{bots.reduce((acc, bot) => acc + bot.conversations, 0).toLocaleString()}</p></div><MessageSquare className="h-5 w-5 text-primary" /></div></CardContent></Card>
          <Card><CardContent className="p-5"><div className="flex items-center justify-between"><div><p className="text-xs uppercase tracking-wider text-muted-foreground">Avg Response Rate</p><p className="mt-1 text-2xl font-semibold">{(bots.reduce((acc, bot) => acc + bot.responseRate, 0) / bots.length).toFixed(1)}%</p></div><TrendingUp className="h-5 w-5 text-accent" /></div></CardContent></Card>
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {bots.map((bot) => (
            <Card key={bot.id}><CardContent className="space-y-4 p-6"><div className="flex items-start justify-between gap-3"><div className="flex items-center gap-3"><div className={`flex h-12 w-12 items-center justify-center rounded-full ${bot.color} text-white`}><Bot className="h-6 w-6" /></div><div><h3 className="text-lg font-semibold">{bot.name}</h3><p className="text-sm text-muted-foreground">{bot.description}</p></div></div><Badge className={bot.status === "active" ? "border-accent/30 bg-accent/10 text-accent" : "border-primary/30 bg-primary/10 text-primary"}>{bot.status}</Badge></div><div className="grid grid-cols-2 gap-3 text-sm"><div className="rounded-lg bg-secondary/50 p-3"><div className="text-muted-foreground">Conversations</div><div className="mt-1 font-semibold">{bot.conversations.toLocaleString()}</div></div><div className="rounded-lg bg-secondary/50 p-3"><div className="text-muted-foreground">Response Rate</div><div className="mt-1 font-semibold">{bot.responseRate}%</div></div><div className="rounded-lg bg-secondary/50 p-3"><div className="text-muted-foreground">Avg Response</div><div className="mt-1 font-semibold">{bot.avgResponseTime}</div></div><div className="rounded-lg bg-secondary/50 p-3"><div className="text-muted-foreground">Last Active</div><div className="mt-1 font-semibold">{bot.lastActive}</div></div></div><div className="flex flex-wrap gap-2">{bot.triggers.map((trigger) => <Badge key={trigger} className="border-border bg-secondary text-muted-foreground">{trigger}</Badge>)}</div></CardContent></Card>
          ))}
        </div>
      </div>
    </div>
  );
}
