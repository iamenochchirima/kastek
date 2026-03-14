"use client";

import { motion } from "framer-motion";
import { ArrowUpRight, Eye, Megaphone, MessageSquare, Phone, TrendingUp, UserCheck, Users, UserX, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

const statsCards = [
  { label: "Connected Numbers", value: "3", sublabel: "3 verified", icon: Phone, trend: "+1 this week" },
  { label: "Templates Ready", value: "12", sublabel: "2 pending review", icon: MessageSquare, trend: "4 approved today" },
  { label: "Active Campaigns", value: "5", sublabel: "8 total campaigns", icon: Megaphone, trend: "2 scheduled" },
  { label: "Opted-in Contacts", value: "2,847", sublabel: "156 excluded", icon: UserCheck, trend: "+89 this week" },
];

const metricsCards = [
  { label: "Delivery Rate", value: "94.2%", sublabel: "2,682 delivered from 2,847 recipients", icon: TrendingUp },
  { label: "Read Rate", value: "67.8%", sublabel: "1,818 reads across all campaigns", icon: Eye },
  { label: "Avg Remaining Today", value: "847", sublabel: "Estimated remaining sends per connected number", icon: Phone },
];

const recentCampaigns = [
  { name: "Spring Sale Promo", status: "Active", sent: 1247, read: 823, time: "2 hours ago" },
  { name: "Welcome Series #3", status: "Active", sent: 892, read: 654, time: "5 hours ago" },
  { name: "Re-engagement Flow", status: "Paused", sent: 456, read: 198, time: "1 day ago" },
];

const reviewQueue = [
  { name: "Order Confirmation v2", status: "Pending", submitted: "2 hours ago" },
  { name: "Shipping Update", status: "Approved", submitted: "1 day ago" },
  { name: "Feedback Request", status: "Rejected", submitted: "3 days ago" },
];

const contactStats = [
  { label: "All Contacts", value: "3,003", sublabel: "Total contact records available to segment and target", icon: Users },
  { label: "Excluded Contacts", value: "156", sublabel: "Contacts currently excluded from marketing sends", icon: UserX },
  { label: "Failures Recorded", value: "101", sublabel: "Combined failed and blocked outcomes across all campaigns", icon: XCircle },
];

const connectionHealth = [
  { number: "+1 (555) 123-4567", quality: 95, status: "Excellent" },
  { number: "+1 (555) 987-6543", quality: 78, status: "Good" },
  { number: "+1 (555) 456-7890", quality: 45, status: "Warning" },
];

export default function Dashboard2Page() {
  return (
    <div className="min-h-screen p-6 lg:p-8">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mx-auto max-w-[1600px] space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Badge className="mb-2 border-primary/30 bg-primary/5 text-primary">Workspace Pulse</Badge>
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">Welcome back, Admin</h1>
            <p className="mt-1 max-w-xl text-muted-foreground">Keep an eye on connected numbers, template approvals, campaign performance, and how much sending capacity you still have today.</p>
          </div>
          <Button className="shrink-0 gap-2"><Megaphone className="h-4 w-4" />Launch Campaign</Button>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {statsCards.map((stat) => (
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
                <p className="mt-3 flex items-center gap-1 text-xs text-accent"><TrendingUp className="h-3 w-3" />{stat.trend}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {metricsCards.map((metric) => (
                <Card key={metric.label} className="bg-secondary/50">
                  <CardContent className="p-5">
                    <p className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">{metric.label}</p>
                    <p className="text-3xl font-semibold text-foreground">{metric.value}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{metric.sublabel}</p>
                  </CardContent>
                </Card>
              ))}
            </div>

            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <div>
                    <CardTitle className="text-base">Recent Campaigns</CardTitle>
                    <CardDescription>Latest updates across your outbound WhatsApp work.</CardDescription>
                  </div>
                  <Button variant="link" className="gap-1 p-0">Open campaigns<ArrowUpRight className="h-3 w-3" /></Button>
                </CardHeader>
                <CardContent className="space-y-3">
                  {recentCampaigns.map((campaign) => (
                    <div key={campaign.name} className="flex items-center justify-between rounded-md bg-secondary/50 p-3">
                      <div className="flex items-center gap-3">
                        <div className={`h-2 w-2 rounded-full ${campaign.status === "Active" ? "bg-accent" : "bg-muted-foreground"}`} />
                        <div>
                          <p className="text-sm font-medium text-foreground">{campaign.name}</p>
                          <p className="text-xs text-muted-foreground">{campaign.time}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-medium text-foreground">{campaign.read}/{campaign.sent}</p>
                        <p className="text-xs text-muted-foreground">read / sent</p>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <div>
                    <CardTitle className="text-base">Review Queue</CardTitle>
                    <CardDescription>Templates that still need attention from Meta or from you.</CardDescription>
                  </div>
                  <Button variant="link" className="gap-1 p-0">Open templates<ArrowUpRight className="h-3 w-3" /></Button>
                </CardHeader>
                <CardContent className="space-y-3">
                  {reviewQueue.map((template) => (
                    <div key={template.name} className="flex items-center justify-between rounded-md bg-secondary/50 p-3">
                      <div>
                        <p className="text-sm font-medium text-foreground">{template.name}</p>
                        <p className="text-xs text-muted-foreground">{template.submitted}</p>
                      </div>
                      <Badge className={template.status === "Approved" ? "border-accent/30 bg-accent/10 text-accent" : template.status === "Rejected" ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-primary/30 bg-primary/10 text-primary"}>{template.status}</Badge>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {contactStats.map((stat) => (
                <Card key={stat.label}>
                  <CardContent className="p-5">
                    <div className="mb-3 flex items-start justify-between">
                      <p className="text-xs uppercase tracking-wider text-muted-foreground">{stat.label}</p>
                      <stat.icon className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <p className="text-3xl font-semibold text-foreground">{stat.value}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{stat.sublabel}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Connection Health</CardTitle>
                <CardDescription>Review quality before the next large launch.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {connectionHealth.map((connection) => (
                  <div key={connection.number} className="space-y-2 rounded-md bg-secondary/50 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-foreground">{connection.number}</span>
                      <span className="text-xs text-muted-foreground">{connection.status}</span>
                    </div>
                    <Progress value={connection.quality} />
                    <div className="text-xs text-muted-foreground">{connection.quality}% quality score</div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
