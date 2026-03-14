"use client"

import { motion } from "framer-motion"
import { 
  Zap,
  ArrowLeft,
  Pause,
  BarChart3,
  Users,
  Send,
  Eye,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
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

const activeCampaigns = [
  {
    id: 1,
    name: "Spring Sale 2024",
    template: "Flash Sale Alert",
    audience: 2847,
    sent: 2682,
    delivered: 2534,
    read: 1876,
    progress: 94,
  },
  {
    id: 2,
    name: "Welcome Series - Day 1",
    template: "Welcome Message",
    audience: 1234,
    sent: 1189,
    delivered: 1145,
    read: 987,
    progress: 100,
  },
]

export default function ActiveCampaignsPage() {
  return (
    <div className="min-h-screen p-6 lg:p-8">
      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="max-w-[1200px] mx-auto space-y-6"
      >
        {/* Header */}
        <motion.div variants={item} className="flex items-center gap-4">
          <Link href="/dashboard/campaigns">
            <Button variant="ghost" size="icon" className="h-9 w-9">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold text-foreground tracking-tight">Active Campaigns</h1>
              <Badge className="bg-accent/10 text-accent border-accent/30">
                {activeCampaigns.length} Running
              </Badge>
            </div>
            <p className="text-muted-foreground text-sm">
              Currently running campaigns sending messages.
            </p>
          </div>
        </motion.div>

        {/* Campaigns */}
        <motion.div variants={item} className="space-y-4">
          {activeCampaigns.map((campaign) => (
            <Card key={campaign.id} className="bg-card border-border">
              <CardContent className="p-6">
                <div className="flex flex-col lg:flex-row lg:items-center gap-6">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="text-lg font-semibold text-foreground">{campaign.name}</h3>
                      <Badge variant="outline" className="border-accent/30 text-accent bg-accent/10">
                        <Zap className="h-3 w-3 mr-1" />
                        Active
                      </Badge>
                    </div>
                    <div className="flex items-center gap-4 text-sm text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Send className="h-3 w-3" />
                        {campaign.template}
                      </span>
                      <span className="flex items-center gap-1">
                        <Users className="h-3 w-3" />
                        {campaign.audience.toLocaleString()} recipients
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-6">
                    <div className="text-center">
                      <p className="text-2xl font-semibold text-foreground">{campaign.sent.toLocaleString()}</p>
                      <p className="text-xs text-muted-foreground">Sent</p>
                    </div>
                    <div className="text-center">
                      <p className="text-2xl font-semibold text-accent">{campaign.read.toLocaleString()}</p>
                      <p className="text-xs text-muted-foreground">Read</p>
                    </div>
                    <div className="text-center">
                      <p className="text-2xl font-semibold text-primary">
                        {Math.round((campaign.read / campaign.sent) * 100)}%
                      </p>
                      <p className="text-xs text-muted-foreground">Rate</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" className="gap-1 border-border">
                      <Pause className="h-3 w-3" />
                      Pause
                    </Button>
                    <Link href="/dashboard/campaigns/analytics">
                      <Button variant="outline" size="sm" className="gap-1 border-border">
                        <BarChart3 className="h-3 w-3" />
                        Analytics
                      </Button>
                    </Link>
                  </div>
                </div>

                <div className="mt-4 pt-4 border-t border-border">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-muted-foreground">Progress</span>
                    <span className="text-sm font-medium text-foreground">{campaign.progress}%</span>
                  </div>
                  <Progress value={campaign.progress} className="h-2 bg-secondary" indicatorClassName="bg-accent" />
                </div>
              </CardContent>
            </Card>
          ))}
        </motion.div>
      </motion.div>
    </div>
  )
}
