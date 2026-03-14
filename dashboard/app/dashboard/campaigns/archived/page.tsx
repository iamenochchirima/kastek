"use client"

import { motion } from "framer-motion"
import { 
  Archive,
  ArrowLeft,
  RotateCcw,
  Trash2,
  Eye,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
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

const archivedCampaigns = [
  {
    id: 1,
    name: "Holiday Promo 2023",
    sent: 4521,
    read: 3456,
    archivedAt: "Jan 5, 2024",
  },
  {
    id: 2,
    name: "Black Friday Sale",
    sent: 3890,
    read: 2987,
    archivedAt: "Dec 1, 2023",
  },
  {
    id: 3,
    name: "Summer Campaign",
    sent: 2456,
    read: 1823,
    archivedAt: "Sep 15, 2023",
  },
]

export default function ArchivedCampaignsPage() {
  return (
    <div className="min-h-screen p-6 lg:p-8">
      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="max-w-[1000px] mx-auto space-y-6"
      >
        {/* Header */}
        <motion.div variants={item} className="flex items-center gap-4">
          <Link href="/dashboard/campaigns">
            <Button variant="ghost" size="icon" className="h-9 w-9">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-semibold text-foreground tracking-tight">Archived Campaigns</h1>
            <p className="text-muted-foreground text-sm">
              Past campaigns that have been archived.
            </p>
          </div>
        </motion.div>

        {/* Campaigns */}
        <motion.div variants={item} className="space-y-4">
          {archivedCampaigns.map((campaign) => (
            <Card key={campaign.id} className="bg-card border-border">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="p-2 rounded-md bg-secondary">
                      <Archive className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="text-base font-semibold text-foreground">{campaign.name}</h3>
                      <p className="text-sm text-muted-foreground">
                        {campaign.sent.toLocaleString()} sent · {campaign.read.toLocaleString()} read · Archived {campaign.archivedAt}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" className="gap-1 text-muted-foreground">
                      <Eye className="h-3 w-3" />
                      View
                    </Button>
                    <Button variant="ghost" size="sm" className="gap-1 text-muted-foreground">
                      <RotateCcw className="h-3 w-3" />
                      Restore
                    </Button>
                    <Button variant="ghost" size="sm" className="gap-1 text-destructive hover:text-destructive">
                      <Trash2 className="h-3 w-3" />
                      Delete
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </motion.div>

        {/* Empty State */}
        {archivedCampaigns.length === 0 && (
          <motion.div variants={item} className="text-center py-12">
            <Archive className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-foreground mb-2">No archived campaigns</h3>
            <p className="text-muted-foreground">Archived campaigns will appear here.</p>
          </motion.div>
        )}
      </motion.div>
    </div>
  )
}
