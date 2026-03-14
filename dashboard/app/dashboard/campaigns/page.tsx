"use client"

import { useState } from "react"
import { motion } from "framer-motion"
import { 
  Search, 
  MoreVertical, 
  Plus,
  Play,
  Pause,
  Trash2,
  Edit,
  Copy,
  BarChart3,
  Clock,
  Send,
  CheckCircle,
  XCircle,
  Eye,
  Users,
  TrendingUp,
  Calendar,
  Zap,
  Archive,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
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

const campaigns = [
  {
    id: 1,
    name: "Spring Sale 2024",
    status: "active",
    template: "Flash Sale Alert",
    audience: 2847,
    sent: 2682,
    delivered: 2534,
    read: 1876,
    startDate: "Feb 1, 2024",
    endDate: "Feb 15, 2024",
    progress: 94,
  },
  {
    id: 2,
    name: "Welcome Series - Day 1",
    status: "active",
    template: "Welcome Message",
    audience: 1234,
    sent: 1189,
    delivered: 1145,
    read: 987,
    startDate: "Jan 1, 2024",
    endDate: "Ongoing",
    progress: 100,
  },
  {
    id: 3,
    name: "Re-engagement Campaign",
    status: "paused",
    template: "Feedback Request",
    audience: 567,
    sent: 234,
    delivered: 221,
    read: 145,
    startDate: "Feb 5, 2024",
    endDate: "Feb 20, 2024",
    progress: 41,
  },
  {
    id: 4,
    name: "Product Launch Teaser",
    status: "scheduled",
    template: "Flash Sale Alert",
    audience: 3500,
    sent: 0,
    delivered: 0,
    read: 0,
    startDate: "Feb 14, 2024",
    endDate: "Feb 14, 2024",
    progress: 0,
  },
  {
    id: 5,
    name: "Holiday Promo 2023",
    status: "completed",
    template: "Flash Sale Alert",
    audience: 4521,
    sent: 4521,
    delivered: 4298,
    read: 3456,
    startDate: "Dec 20, 2023",
    endDate: "Dec 31, 2023",
    progress: 100,
  },
]

const stats = [
  { label: "Total Campaigns", value: campaigns.length, icon: Send },
  { label: "Active", value: campaigns.filter(c => c.status === "active").length, icon: Zap, color: "text-accent" },
  { label: "Messages Sent", value: "11.1K", icon: CheckCircle, color: "text-primary" },
  { label: "Avg Read Rate", value: "72.4%", icon: Eye, color: "text-blue-500" },
]

export default function CampaignsPage() {
  const [filter, setFilter] = useState("all")
  const [searchQuery, setSearchQuery] = useState("")

  const filteredCampaigns = campaigns.filter(campaign => {
    const matchesSearch = campaign.name.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesFilter = filter === "all" || campaign.status === filter
    return matchesSearch && matchesFilter
  })

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "active":
        return (
          <Badge variant="outline" className="border-accent/30 text-accent bg-accent/10">
            <Zap className="h-3 w-3 mr-1" />
            Active
          </Badge>
        )
      case "paused":
        return (
          <Badge variant="outline" className="border-primary/30 text-primary bg-primary/10">
            <Pause className="h-3 w-3 mr-1" />
            Paused
          </Badge>
        )
      case "scheduled":
        return (
          <Badge variant="outline" className="border-blue-500/30 text-blue-500 bg-blue-500/10">
            <Clock className="h-3 w-3 mr-1" />
            Scheduled
          </Badge>
        )
      case "completed":
        return (
          <Badge variant="outline" className="border-muted-foreground/30 text-muted-foreground bg-muted-foreground/10">
            <CheckCircle className="h-3 w-3 mr-1" />
            Completed
          </Badge>
        )
      default:
        return null
    }
  }

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
          <div>
            <h1 className="text-3xl font-semibold text-foreground tracking-tight">Campaigns</h1>
            <p className="text-muted-foreground mt-1">
              Launch and monitor your WhatsApp marketing campaigns.
            </p>
          </div>
          <Link href="/dashboard/campaigns/create">
            <Button className="bg-primary text-primary-foreground hover:bg-primary/90 gap-2">
              <Plus className="h-4 w-4" />
              Create Campaign
            </Button>
          </Link>
        </motion.div>

        {/* Stats */}
        <motion.div variants={item} className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {stats.map((stat, index) => (
            <Card key={index} className="bg-card border-border">
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-wider text-muted-foreground">{stat.label}</p>
                    <p className="text-2xl font-semibold text-foreground mt-1">{stat.value}</p>
                  </div>
                  <stat.icon className={`h-5 w-5 ${stat.color || 'text-muted-foreground'}`} />
                </div>
              </CardContent>
            </Card>
          ))}
        </motion.div>

        {/* Filters */}
        <motion.div variants={item} className="flex flex-col sm:flex-row gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input 
              placeholder="Search campaigns..." 
              className="pl-9 bg-card border-border"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <Tabs value={filter} onValueChange={setFilter}>
            <TabsList className="bg-secondary">
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="active">Active</TabsTrigger>
              <TabsTrigger value="paused">Paused</TabsTrigger>
              <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
              <TabsTrigger value="completed">Completed</TabsTrigger>
            </TabsList>
          </Tabs>
        </motion.div>

        {/* Campaigns List */}
        <motion.div variants={item} className="space-y-4">
          {filteredCampaigns.map((campaign) => (
            <Card 
              key={campaign.id} 
              className="bg-card border-border hover:border-primary/30 transition-all duration-300"
            >
              <CardContent className="p-6">
                <div className="flex flex-col lg:flex-row lg:items-center gap-6">
                  {/* Campaign Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="text-lg font-semibold text-foreground truncate">
                        {campaign.name}
                      </h3>
                      {getStatusBadge(campaign.status)}
                    </div>
                    <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Send className="h-3 w-3" />
                        {campaign.template}
                      </span>
                      <span className="flex items-center gap-1">
                        <Users className="h-3 w-3" />
                        {campaign.audience.toLocaleString()} recipients
                      </span>
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {campaign.startDate} - {campaign.endDate}
                      </span>
                    </div>
                  </div>

                  {/* Stats */}
                  <div className="flex items-center gap-6">
                    <div className="text-center">
                      <p className="text-2xl font-semibold text-foreground">
                        {campaign.sent.toLocaleString()}
                      </p>
                      <p className="text-xs text-muted-foreground">Sent</p>
                    </div>
                    <div className="text-center">
                      <p className="text-2xl font-semibold text-foreground">
                        {campaign.delivered.toLocaleString()}
                      </p>
                      <p className="text-xs text-muted-foreground">Delivered</p>
                    </div>
                    <div className="text-center">
                      <p className="text-2xl font-semibold text-accent">
                        {campaign.read.toLocaleString()}
                      </p>
                      <p className="text-xs text-muted-foreground">Read</p>
                    </div>
                    <div className="text-center min-w-[80px]">
                      <p className="text-2xl font-semibold text-primary">
                        {campaign.sent > 0 ? Math.round((campaign.read / campaign.sent) * 100) : 0}%
                      </p>
                      <p className="text-xs text-muted-foreground">Read Rate</p>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2">
                    {campaign.status === "active" && (
                      <Button variant="outline" size="sm" className="gap-1 border-border">
                        <Pause className="h-3 w-3" />
                        Pause
                      </Button>
                    )}
                    {campaign.status === "paused" && (
                      <Button variant="outline" size="sm" className="gap-1 border-border">
                        <Play className="h-3 w-3" />
                        Resume
                      </Button>
                    )}
                    <Link href="/dashboard/campaigns/analytics">
                      <Button variant="outline" size="sm" className="gap-1 border-border">
                        <BarChart3 className="h-3 w-3" />
                        Analytics
                      </Button>
                    </Link>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem>
                          <Eye className="mr-2 h-4 w-4" />
                          View Details
                        </DropdownMenuItem>
                        <DropdownMenuItem>
                          <Edit className="mr-2 h-4 w-4" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem>
                          <Copy className="mr-2 h-4 w-4" />
                          Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuItem>
                          <Archive className="mr-2 h-4 w-4" />
                          Archive
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-destructive">
                          <Trash2 className="mr-2 h-4 w-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>

                {/* Progress Bar */}
                {campaign.status !== "completed" && campaign.progress > 0 && (
                  <div className="mt-4 pt-4 border-t border-border">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-muted-foreground">Campaign Progress</span>
                      <span className="text-sm font-medium text-foreground">{campaign.progress}%</span>
                    </div>
                    <Progress 
                      value={campaign.progress} 
                      className="h-2 bg-secondary"
                      indicatorClassName={campaign.status === "active" ? "bg-accent" : "bg-primary"}
                    />
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </motion.div>

        {/* Empty State */}
        {filteredCampaigns.length === 0 && (
          <motion.div 
            variants={item}
            className="text-center py-12"
          >
            <Send className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-foreground mb-2">No campaigns found</h3>
            <p className="text-muted-foreground mb-4">
              {searchQuery ? "Try adjusting your search or filters" : "Create your first campaign to get started"}
            </p>
            <Link href="/dashboard/campaigns/create">
              <Button className="bg-primary text-primary-foreground">
                <Plus className="h-4 w-4 mr-2" />
                Create Campaign
              </Button>
            </Link>
          </motion.div>
        )}
      </motion.div>
    </div>
  )
}
