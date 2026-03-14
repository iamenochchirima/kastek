"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import Link from "next/link";
import { Plus, Search } from "lucide-react";

const templates = [
  { id: 1, name: "Welcome Message", category: "Onboarding", status: "approved", content: "Hi {{1}}! Welcome to our service. We are excited to have you on board.", usedIn: 3, lastUsed: "2 hours ago" },
  { id: 2, name: "Order Confirmation", category: "Transactional", status: "approved", content: "Your order #{{1}} has been confirmed. Estimated delivery: {{2}}.", usedIn: 5, lastUsed: "30 min ago" },
  { id: 3, name: "Shipping Update", category: "Transactional", status: "pending", content: "Great news! Your package is on its way.", usedIn: 0, lastUsed: "Never" },
  { id: 4, name: "Feedback Request", category: "Marketing", status: "rejected", content: "We would love your feedback on your recent purchase.", usedIn: 2, lastUsed: "3 days ago" },
];

export default function Dashboard2TemplatesPage() {
  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1400px] space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Templates</h1>
            <p className="mt-1 text-muted-foreground">Create and manage your WhatsApp message templates.</p>
          </div>
          <Link href="/dashboard2/templates/create" className="no-underline"><Button><Plus className="h-4 w-4" />Create Template</Button></Link>
        </div>
        <div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input placeholder="Search templates..." className="pl-9" /></div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => (
            <Card key={template.id}><CardContent className="space-y-4 p-5"><div className="flex items-start justify-between gap-3"><div><h3 className="text-base font-semibold">{template.name}</h3><Badge className="mt-1 border-border bg-secondary text-muted-foreground">{template.category}</Badge></div><Badge className={template.status === "approved" ? "border-accent/30 bg-accent/10 text-accent" : template.status === "pending" ? "border-primary/30 bg-primary/10 text-primary" : "border-destructive/30 bg-destructive/10 text-destructive"}>{template.status}</Badge></div><p className="text-sm text-muted-foreground">{template.content}</p><div className="grid grid-cols-2 gap-3 text-sm"><div className="rounded-lg bg-secondary/50 p-3"><div className="text-muted-foreground">Used In</div><div className="mt-1 font-semibold">{template.usedIn}</div></div><div className="rounded-lg bg-secondary/50 p-3"><div className="text-muted-foreground">Last Used</div><div className="mt-1 font-semibold">{template.lastUsed}</div></div></div></CardContent></Card>
          ))}
        </div>
      </div>
    </div>
  );
}
