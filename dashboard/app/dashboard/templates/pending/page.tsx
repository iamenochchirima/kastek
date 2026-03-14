"use client"

import { motion } from "framer-motion"
import { 
  Clock,
  FileText,
  AlertCircle,
  ArrowLeft,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
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

const pendingTemplates = [
  {
    id: 1,
    name: "Shipping Update",
    category: "Transactional",
    content: "Great news! Your package is on its way. Expected delivery: {{1}}. Track here: {{2}}",
    submittedAt: "2 hours ago",
    estimatedReview: "24-48 hours",
  },
  {
    id: 2,
    name: "Flash Sale Alert",
    category: "Marketing",
    content: "Flash Sale! Get {{1}}% off everything for the next {{2}} hours. Shop now: {{3}}",
    submittedAt: "1 day ago",
    estimatedReview: "24-48 hours",
  },
]

export default function PendingTemplatesPage() {
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
          <Link href="/dashboard/templates">
            <Button variant="ghost" size="icon" className="h-9 w-9">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-semibold text-foreground tracking-tight">Pending Review</h1>
            <p className="text-muted-foreground text-sm">
              Templates waiting for Meta approval.
            </p>
          </div>
        </motion.div>

        {/* Info Card */}
        <motion.div variants={item}>
          <Card className="bg-primary/5 border-primary/20">
            <CardContent className="p-4">
              <div className="flex gap-3">
                <AlertCircle className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-foreground">Review Process</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Templates are reviewed by Meta within 24-48 hours. You will be notified once a decision is made.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Pending Templates */}
        <motion.div variants={item} className="space-y-4">
          {pendingTemplates.map((template) => (
            <Card key={template.id} className="bg-card border-border">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-base">{template.name}</CardTitle>
                    <Badge variant="outline" className="mt-1 text-xs border-border">
                      {template.category}
                    </Badge>
                  </div>
                  <Badge variant="outline" className="border-primary/30 text-primary bg-primary/10">
                    <Clock className="h-3 w-3 mr-1" />
                    Pending
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="p-3 rounded-lg bg-secondary/50 border border-border">
                  <p className="text-sm text-muted-foreground">{template.content}</p>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Submitted: {template.submittedAt}</span>
                  <span className="text-muted-foreground">Est. review: {template.estimatedReview}</span>
                </div>
              </CardContent>
            </Card>
          ))}
        </motion.div>

        {/* Empty State */}
        {pendingTemplates.length === 0 && (
          <motion.div variants={item} className="text-center py-12">
            <Clock className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-foreground mb-2">No pending templates</h3>
            <p className="text-muted-foreground">All your templates have been reviewed.</p>
          </motion.div>
        )}
      </motion.div>
    </div>
  )
}
