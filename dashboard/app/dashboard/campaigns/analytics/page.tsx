"use client"

import { motion } from "framer-motion"
import { 
  ArrowLeft,
  TrendingUp,
  TrendingDown,
  Send,
  CheckCircle,
  Eye,
  MousePointer,
  Clock,
  Users,
  Calendar,
  Download,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import Link from "next/link"

const container = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.05 }
  }
}

const item = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" } }
}

const stats = [
  { label: "Total Sent", value: "11,247", change: "+12.5%", trend: "up", icon: Send },
  { label: "Delivered", value: "10,834", change: "+11.2%", trend: "up", icon: CheckCircle },
  { label: "Read", value: "8,142", change: "+8.7%", trend: "up", icon: Eye },
  { label: "Click Rate", value: "24.3%", change: "-2.1%", trend: "down", icon: MousePointer },
]

const hourlyData = [
  { hour: "12AM", sent: 45, delivered: 42, read: 28 },
  { hour: "3AM", sent: 12, delivered: 11, read: 8 },
  { hour: "6AM", sent: 89, delivered: 85, read: 67 },
  { hour: "9AM", sent: 234, delivered: 228, read: 189 },
  { hour: "12PM", sent: 456, delivered: 445, read: 378 },
  { hour: "3PM", sent: 523, delivered: 512, read: 423 },
  { hour: "6PM", sent: 389, delivered: 378, read: 312 },
  { hour: "9PM", sent: 267, delivered: 259, read: 198 },
]

const topCampaigns = [
  { name: "Spring Sale 2024", sent: 2847, read: 2156, rate: 75.7 },
  { name: "Welcome Series", sent: 1234, read: 987, rate: 80.0 },
  { name: "Product Launch", sent: 3500, read: 2450, rate: 70.0 },
  { name: "Re-engagement", sent: 567, read: 312, rate: 55.0 },
]

export default function AnalyticsPage() {
  return (
    <div className="min-h-screen p-6 lg:p-8">
      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="max-w-[1400px] mx-auto space-y-6"
      >
        {/* Header */}
        <motion.div variants={item} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-4">
            <Link href="/dashboard/campaigns">
              <Button variant="ghost" size="icon" className="h-9 w-9">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-semibold text-foreground tracking-tight">Campaign Analytics</h1>
              <p className="text-muted-foreground text-sm">
                Track performance across all your campaigns.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Select defaultValue="7d">
              <SelectTrigger className="w-[140px] bg-card border-border">
                <Calendar className="h-4 w-4 mr-2" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="24h">Last 24 hours</SelectItem>
                <SelectItem value="7d">Last 7 days</SelectItem>
                <SelectItem value="30d">Last 30 days</SelectItem>
                <SelectItem value="90d">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" className="gap-2 border-border">
              <Download className="h-4 w-4" />
              Export
            </Button>
          </div>
        </motion.div>

        {/* Stats */}
        <motion.div variants={item} className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {stats.map((stat, index) => (
            <Card key={index} className="bg-card border-border">
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="p-2 rounded-md bg-primary/10">
                    <stat.icon className="h-5 w-5 text-primary" />
                  </div>
                  <Badge 
                    variant="outline" 
                    className={
                      stat.trend === "up"
                        ? "border-accent/30 text-accent bg-accent/10"
                        : "border-destructive/30 text-destructive bg-destructive/10"
                    }
                  >
                    {stat.trend === "up" ? (
                      <TrendingUp className="h-3 w-3 mr-1" />
                    ) : (
                      <TrendingDown className="h-3 w-3 mr-1" />
                    )}
                    {stat.change}
                  </Badge>
                </div>
                <p className="text-2xl font-semibold text-foreground">{stat.value}</p>
                <p className="text-sm text-muted-foreground">{stat.label}</p>
              </CardContent>
            </Card>
          ))}
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Chart Area */}
          <motion.div variants={item} className="lg:col-span-2">
            <Card className="bg-card border-border">
              <CardHeader>
                <CardTitle>Message Activity</CardTitle>
                <CardDescription>Hourly breakdown of message performance.</CardDescription>
              </CardHeader>
              <CardContent>
                {/* Simple bar chart visualization */}
                <div className="space-y-4">
                  {hourlyData.map((data, index) => (
                    <div key={index} className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground w-12">{data.hour}</span>
                        <div className="flex items-center gap-4 text-xs">
                          <span className="text-foreground">{data.sent} sent</span>
                          <span className="text-accent">{data.read} read</span>
                        </div>
                      </div>
                      <div className="relative h-8 bg-secondary rounded-md overflow-hidden">
                        <div 
                          className="absolute inset-y-0 left-0 bg-primary/30 transition-all"
                          style={{ width: `${(data.sent / 600) * 100}%` }}
                        />
                        <div 
                          className="absolute inset-y-0 left-0 bg-primary/60 transition-all"
                          style={{ width: `${(data.delivered / 600) * 100}%` }}
                        />
                        <div 
                          className="absolute inset-y-0 left-0 bg-accent transition-all"
                          style={{ width: `${(data.read / 600) * 100}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>

                {/* Legend */}
                <div className="flex items-center justify-center gap-6 mt-6 pt-4 border-t border-border">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-sm bg-primary/30" />
                    <span className="text-xs text-muted-foreground">Sent</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-sm bg-primary/60" />
                    <span className="text-xs text-muted-foreground">Delivered</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-sm bg-accent" />
                    <span className="text-xs text-muted-foreground">Read</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>

          {/* Top Campaigns */}
          <motion.div variants={item}>
            <Card className="bg-card border-border">
              <CardHeader>
                <CardTitle>Top Campaigns</CardTitle>
                <CardDescription>Best performing campaigns by read rate.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {topCampaigns.map((campaign, index) => (
                  <div key={index} className="p-4 rounded-lg bg-secondary/50 border border-border">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-medium text-foreground truncate">{campaign.name}</p>
                      <Badge 
                        variant="outline" 
                        className={
                          campaign.rate > 70 
                            ? "border-accent/30 text-accent bg-accent/10"
                            : campaign.rate > 50
                            ? "border-primary/30 text-primary bg-primary/10"
                            : "border-muted-foreground/30 text-muted-foreground bg-muted-foreground/10"
                        }
                      >
                        {campaign.rate}%
                      </Badge>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                      <span>{campaign.sent.toLocaleString()} sent</span>
                      <span>{campaign.read.toLocaleString()} read</span>
                    </div>
                    <div className="mt-2 h-1.5 bg-secondary rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-accent transition-all"
                        style={{ width: `${campaign.rate}%` }}
                      />
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </motion.div>
        </div>

        {/* Delivery Breakdown */}
        <motion.div variants={item}>
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle>Delivery Breakdown</CardTitle>
              <CardDescription>Message status distribution across all campaigns.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
                {[
                  { label: "Sent", value: 11247, percentage: 100, color: "bg-foreground" },
                  { label: "Delivered", value: 10834, percentage: 96.3, color: "bg-primary" },
                  { label: "Read", value: 8142, percentage: 72.4, color: "bg-accent" },
                  { label: "Failed", value: 289, percentage: 2.6, color: "bg-destructive" },
                  { label: "Pending", value: 124, percentage: 1.1, color: "bg-muted-foreground" },
                ].map((item, index) => (
                  <div key={index} className="text-center p-4 rounded-lg bg-secondary/50 border border-border">
                    <div className={`w-4 h-4 rounded-full ${item.color} mx-auto mb-3`} />
                    <p className="text-2xl font-semibold text-foreground">{item.value.toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground">{item.label}</p>
                    <p className="text-xs text-muted-foreground mt-1">{item.percentage}%</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </motion.div>
    </div>
  )
}
