"use client"

import { motion } from "framer-motion"
import { 
  CheckCircle,
  FileText,
  ArrowLeft,
  MessageSquare,
  Copy,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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

const approvedTemplates = [
  {
    id: 1,
    name: "Welcome Message",
    category: "Onboarding",
    content: "Hi {{1}}! Welcome to our service. We're excited to have you on board.",
    usedIn: 3,
    approvedAt: "Jan 10, 2024",
  },
  {
    id: 2,
    name: "Order Confirmation",
    category: "Transactional",
    content: "Your order #{{1}} has been confirmed! Estimated delivery: {{2}}.",
    usedIn: 5,
    approvedAt: "Jan 15, 2024",
  },
  {
    id: 3,
    name: "Appointment Reminder",
    category: "Utility",
    content: "Reminder: Your appointment with {{1}} is scheduled for {{2}}.",
    usedIn: 8,
    approvedAt: "Dec 5, 2023",
  },
]

export default function ApprovedTemplatesPage() {
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
          <Link href="/dashboard/templates">
            <Button variant="ghost" size="icon" className="h-9 w-9">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-semibold text-foreground tracking-tight">Approved Templates</h1>
            <p className="text-muted-foreground text-sm">
              Templates ready to use in your campaigns.
            </p>
          </div>
        </motion.div>

        {/* Templates Grid */}
        <motion.div variants={item} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {approvedTemplates.map((template) => (
            <Card key={template.id} className="bg-card border-border hover:border-primary/30 transition-all">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-base">{template.name}</CardTitle>
                    <Badge variant="outline" className="mt-1 text-xs border-border">
                      {template.category}
                    </Badge>
                  </div>
                  <Badge variant="outline" className="border-accent/30 text-accent bg-accent/10">
                    <CheckCircle className="h-3 w-3 mr-1" />
                    Approved
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="p-3 rounded-lg bg-secondary/50 border border-border">
                  <p className="text-sm text-muted-foreground line-clamp-2">{template.content}</p>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <MessageSquare className="h-3 w-3" />
                    {template.usedIn} campaigns
                  </span>
                  <Button variant="ghost" size="sm" className="gap-1 text-xs">
                    <Copy className="h-3 w-3" />
                    Use Template
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </motion.div>
      </motion.div>
    </div>
  )
}
