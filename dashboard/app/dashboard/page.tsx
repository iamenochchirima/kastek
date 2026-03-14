"use client"

import { motion } from "framer-motion"
import { 
  Phone, 
  FileCheck, 
  Megaphone, 
  UserCheck, 
  TrendingUp, 
  Eye, 
  Clock,
  ArrowUpRight,
  MessageSquare,
  AlertCircle,
  Users,
  UserX,
  XCircle,
  Activity,
  Wifi,
  WifiOff,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"

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

const statsCards = [
  { label: "Connected Numbers", value: "3", sublabel: "3 verified", icon: Phone, trend: "+1 this week" },
  { label: "Templates Ready", value: "12", sublabel: "2 pending review", icon: FileCheck, trend: "4 approved today" },
  { label: "Active Campaigns", value: "5", sublabel: "8 total campaigns", icon: Megaphone, trend: "2 scheduled" },
  { label: "Opted-in Contacts", value: "2,847", sublabel: "156 excluded", icon: UserCheck, trend: "+89 this week" },
]

const metricsCards = [
  { label: "Delivery Rate", value: "94.2%", sublabel: "2,682 delivered from 2,847 recipients", icon: TrendingUp },
  { label: "Read Rate", value: "67.8%", sublabel: "1,818 reads across all campaigns", icon: Eye },
  { label: "Avg Remaining Today", value: "847", sublabel: "Estimated remaining sends per connected number", icon: Clock },
]

const sendBreakdown = [
  { label: "Delivered", value: 2682, color: "bg-accent" },
  { label: "Read", value: 1818, color: "bg-primary" },
  { label: "Failed", value: 89, color: "bg-destructive" },
  { label: "Blocked", value: 12, color: "bg-muted-foreground" },
  { label: "Sent", value: 2847, color: "bg-foreground" },
]

const recentCampaigns = [
  { name: "Spring Sale Promo", status: "Active", sent: 1247, delivered: 1198, read: 823, time: "2 hours ago" },
  { name: "Welcome Series #3", status: "Active", sent: 892, delivered: 871, read: 654, time: "5 hours ago" },
  { name: "Re-engagement Flow", status: "Paused", sent: 456, delivered: 421, read: 198, time: "1 day ago" },
]

const reviewQueue = [
  { name: "Order Confirmation v2", status: "Pending", submitted: "2 hours ago" },
  { name: "Shipping Update", status: "Approved", submitted: "1 day ago" },
  { name: "Feedback Request", status: "Rejected", submitted: "3 days ago" },
]

const connectionHealth = [
  { number: "+1 (555) 123-4567", quality: 95, status: "Excellent" },
  { number: "+1 (555) 987-6543", quality: 78, status: "Good" },
  { number: "+1 (555) 456-7890", quality: 45, status: "Warning" },
]

const contactStats = [
  { label: "All Contacts", value: "3,003", sublabel: "Total contact records available to segment and target", icon: Users },
  { label: "Excluded Contacts", value: "156", sublabel: "Contacts currently excluded from marketing sends", icon: UserX },
  { label: "Failures Recorded", value: "101", sublabel: "Combined failed and blocked outcomes across all campaigns", icon: XCircle },
]

export default function DashboardPage() {
  return (
    <div className="min-h-screen p-6 lg:p-8">
      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="max-w-[1600px] mx-auto space-y-6"
      >
        {/* Header */}
        <motion.div variants={item} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <Badge variant="outline" className="mb-2 border-primary/30 text-primary bg-primary/5">
              Workspace Pulse
            </Badge>
            <h1 className="text-3xl font-semibold text-foreground tracking-tight">Welcome back, Admin</h1>
            <p className="text-muted-foreground mt-1 max-w-xl">
              Keep an eye on connected numbers, template approvals, campaign performance, and how much sending capacity you still have today.
            </p>
          </div>
          <Button className="bg-primary text-primary-foreground hover:bg-primary/90 gap-2 shrink-0">
            <Megaphone className="h-4 w-4" />
            Launch Campaign
          </Button>
        </motion.div>

        {/* Stats Cards */}
        <motion.div variants={item} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {statsCards.map((stat, index) => (
            <Card key={index} className="bg-card border-border hover:border-primary/30 transition-colors duration-300">
              <CardContent className="p-5">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">{stat.label}</p>
                    <p className="text-3xl font-semibold text-foreground">{stat.value}</p>
                    <p className="text-sm text-muted-foreground mt-1">{stat.sublabel}</p>
                  </div>
                  <div className="p-2 rounded-md bg-primary/10">
                    <stat.icon className="h-5 w-5 text-primary" />
                  </div>
                </div>
                <p className="text-xs text-accent mt-3 flex items-center gap-1">
                  <TrendingUp className="h-3 w-3" />
                  {stat.trend}
                </p>
              </CardContent>
            </Card>
          ))}
        </motion.div>

        {/* Main Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column - Main Content */}
          <div className="lg:col-span-2 space-y-6">
            {/* Metrics Row */}
            <motion.div variants={item} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {metricsCards.map((metric, index) => (
                <Card key={index} className="bg-secondary/50 border-border">
                  <CardContent className="p-5">
                    <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">{metric.label}</p>
                    <p className="text-3xl font-semibold text-foreground">{metric.value}</p>
                    <p className="text-sm text-muted-foreground mt-1">{metric.sublabel}</p>
                  </CardContent>
                </Card>
              ))}
            </motion.div>

            {/* Recent Campaigns & Review Queue */}
            <motion.div variants={item} className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Recent Campaigns */}
              <Card className="bg-card border-border">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <div>
                    <CardTitle className="text-base font-semibold">Recent Campaigns</CardTitle>
                    <CardDescription>Latest updates across your outbound WhatsApp work.</CardDescription>
                  </div>
                  <Button variant="link" className="text-primary p-0 h-auto gap-1">
                    Open campaigns
                    <ArrowUpRight className="h-3 w-3" />
                  </Button>
                </CardHeader>
                <CardContent className="space-y-3">
                  {recentCampaigns.map((campaign, index) => (
                    <div key={index} className="flex items-center justify-between p-3 rounded-md bg-secondary/50 hover:bg-secondary transition-colors">
                      <div className="flex items-center gap-3">
                        <div className={`w-2 h-2 rounded-full ${campaign.status === 'Active' ? 'bg-accent' : 'bg-muted-foreground'}`} />
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

              {/* Review Queue */}
              <Card className="bg-card border-border">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <div>
                    <CardTitle className="text-base font-semibold">Review Queue</CardTitle>
                    <CardDescription>Templates that still need attention from Meta or from you.</CardDescription>
                  </div>
                  <Button variant="link" className="text-primary p-0 h-auto gap-1">
                    Open templates
                    <ArrowUpRight className="h-3 w-3" />
                  </Button>
                </CardHeader>
                <CardContent className="space-y-3">
                  {reviewQueue.map((template, index) => (
                    <div key={index} className="flex items-center justify-between p-3 rounded-md bg-secondary/50 hover:bg-secondary transition-colors">
                      <div className="flex items-center gap-3">
                        <MessageSquare className="h-4 w-4 text-muted-foreground" />
                        <div>
                          <p className="text-sm font-medium text-foreground">{template.name}</p>
                          <p className="text-xs text-muted-foreground">{template.submitted}</p>
                        </div>
                      </div>
                      <Badge 
                        variant="outline" 
                        className={
                          template.status === 'Approved' 
                            ? 'border-accent/30 text-accent bg-accent/10' 
                            : template.status === 'Rejected'
                            ? 'border-destructive/30 text-destructive bg-destructive/10'
                            : 'border-primary/30 text-primary bg-primary/10'
                        }
                      >
                        {template.status}
                      </Badge>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </motion.div>

            {/* Contact Stats */}
            <motion.div variants={item} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {contactStats.map((stat, index) => (
                <Card key={index} className="bg-card border-border hover:border-primary/30 transition-colors duration-300">
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between mb-3">
                      <p className="text-xs uppercase tracking-wider text-muted-foreground">{stat.label}</p>
                      <stat.icon className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <p className="text-3xl font-semibold text-foreground">{stat.value}</p>
                    <p className="text-sm text-muted-foreground mt-1">{stat.sublabel}</p>
                  </CardContent>
                </Card>
              ))}
            </motion.div>
          </div>

          {/* Right Column - Sidebar */}
          <motion.div variants={item} className="space-y-6">
            {/* 30-Day Send Breakdown */}
            <Card className="bg-card border-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-base font-semibold">30-Day Send Breakdown</CardTitle>
                <CardDescription>Status activity pulled from send events in the last 30 days.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {sendBreakdown.map((item, index) => (
                  <div key={index} className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`w-3 h-3 rounded-sm ${item.color}`} />
                      <span className="text-sm text-muted-foreground">{item.label}</span>
                    </div>
                    <span className="text-sm font-medium text-foreground">{item.value.toLocaleString()}</span>
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* Connection Health */}
            <Card className="bg-card border-border">
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-primary" />
                  <CardTitle className="text-base font-semibold">Connection Health</CardTitle>
                </div>
                <CardDescription>Quality rating and throughput headroom for each number.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {connectionHealth.map((connection, index) => (
                  <div key={index} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {connection.quality > 70 ? (
                          <Wifi className="h-4 w-4 text-accent" />
                        ) : connection.quality > 40 ? (
                          <Wifi className="h-4 w-4 text-primary" />
                        ) : (
                          <WifiOff className="h-4 w-4 text-destructive" />
                        )}
                        <span className="text-sm text-foreground">{connection.number}</span>
                      </div>
                      <Badge 
                        variant="outline" 
                        className={
                          connection.quality > 70 
                            ? 'border-accent/30 text-accent bg-accent/10' 
                            : connection.quality > 40
                            ? 'border-primary/30 text-primary bg-primary/10'
                            : 'border-destructive/30 text-destructive bg-destructive/10'
                        }
                      >
                        {connection.status}
                      </Badge>
                    </div>
                    <Progress 
                      value={connection.quality} 
                      className="h-1.5 bg-secondary"
                      indicatorClassName={
                        connection.quality > 70 
                          ? 'bg-accent' 
                          : connection.quality > 40
                          ? 'bg-primary'
                          : 'bg-destructive'
                      }
                    />
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* Quick Actions */}
            <Card className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
              <CardContent className="p-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="p-2 rounded-md bg-primary/20">
                    <AlertCircle className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">Need Help?</p>
                    <p className="text-xs text-muted-foreground">Check our documentation</p>
                  </div>
                </div>
                <Button variant="outline" className="w-full border-primary/30 text-primary hover:bg-primary/10">
                  View Documentation
                </Button>
              </CardContent>
            </Card>
          </motion.div>
        </div>
      </motion.div>
    </div>
  )
}
