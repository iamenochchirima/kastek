"use client"

import { useState } from "react"
import { motion } from "framer-motion"
import { 
  Search, 
  Filter, 
  MoreVertical, 
  Plus,
  FileText,
  Clock,
  CheckCircle,
  XCircle,
  Copy,
  Edit,
  Trash2,
  Eye,
  MessageSquare,
  ChevronDown,
  AlertCircle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
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

const templates = [
  {
    id: 1,
    name: "Welcome Message",
    category: "Onboarding",
    status: "approved",
    content: "Hi {{1}}! Welcome to our service. We're excited to have you on board. Reply HELP anytime for assistance.",
    usedIn: 3,
    lastUsed: "2 hours ago",
    createdAt: "Jan 10, 2024",
  },
  {
    id: 2,
    name: "Order Confirmation",
    category: "Transactional",
    status: "approved",
    content: "Your order #{{1}} has been confirmed! Estimated delivery: {{2}}. Track your order at {{3}}",
    usedIn: 5,
    lastUsed: "30 min ago",
    createdAt: "Jan 15, 2024",
  },
  {
    id: 3,
    name: "Shipping Update",
    category: "Transactional",
    status: "pending",
    content: "Great news! Your package is on its way. Expected delivery: {{1}}. Track here: {{2}}",
    usedIn: 0,
    lastUsed: "Never",
    createdAt: "Feb 1, 2024",
  },
  {
    id: 4,
    name: "Feedback Request",
    category: "Marketing",
    status: "rejected",
    content: "Hi {{1}}! We'd love your feedback on your recent purchase. Rate us here: {{2}}",
    usedIn: 2,
    lastUsed: "3 days ago",
    createdAt: "Jan 20, 2024",
    rejectionReason: "Template contains promotional content not allowed for transactional messages.",
  },
  {
    id: 5,
    name: "Appointment Reminder",
    category: "Utility",
    status: "approved",
    content: "Reminder: Your appointment with {{1}} is scheduled for {{2}}. Reply YES to confirm or NO to reschedule.",
    usedIn: 8,
    lastUsed: "1 hour ago",
    createdAt: "Dec 5, 2023",
  },
  {
    id: 6,
    name: "Flash Sale Alert",
    category: "Marketing",
    status: "pending",
    content: "🔥 Flash Sale! Get {{1}}% off everything for the next {{2}} hours. Shop now: {{3}}",
    usedIn: 0,
    lastUsed: "Never",
    createdAt: "Feb 5, 2024",
  },
]

const stats = [
  { label: "Total Templates", value: templates.length, icon: FileText },
  { label: "Approved", value: templates.filter(t => t.status === "approved").length, icon: CheckCircle, color: "text-accent" },
  { label: "Pending Review", value: templates.filter(t => t.status === "pending").length, icon: Clock, color: "text-primary" },
  { label: "Rejected", value: templates.filter(t => t.status === "rejected").length, icon: XCircle, color: "text-destructive" },
]

export default function TemplatesPage() {
  const [filter, setFilter] = useState("all")
  const [searchQuery, setSearchQuery] = useState("")

  const filteredTemplates = templates.filter(template => {
    const matchesSearch = template.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      template.content.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesFilter = filter === "all" || template.status === filter
    return matchesSearch && matchesFilter
  })

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "approved":
        return (
          <Badge variant="outline" className="border-accent/30 text-accent bg-accent/10">
            <CheckCircle className="h-3 w-3 mr-1" />
            Approved
          </Badge>
        )
      case "pending":
        return (
          <Badge variant="outline" className="border-primary/30 text-primary bg-primary/10">
            <Clock className="h-3 w-3 mr-1" />
            Pending
          </Badge>
        )
      case "rejected":
        return (
          <Badge variant="outline" className="border-destructive/30 text-destructive bg-destructive/10">
            <XCircle className="h-3 w-3 mr-1" />
            Rejected
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
            <h1 className="text-3xl font-semibold text-foreground tracking-tight">Templates</h1>
            <p className="text-muted-foreground mt-1">
              Create and manage your WhatsApp message templates.
            </p>
          </div>
          <Link href="/dashboard/templates/create">
            <Button className="bg-primary text-primary-foreground hover:bg-primary/90 gap-2">
              <Plus className="h-4 w-4" />
              Create Template
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
              placeholder="Search templates..." 
              className="pl-9 bg-card border-border"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <Tabs value={filter} onValueChange={setFilter}>
            <TabsList className="bg-secondary">
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="approved">Approved</TabsTrigger>
              <TabsTrigger value="pending">Pending</TabsTrigger>
              <TabsTrigger value="rejected">Rejected</TabsTrigger>
            </TabsList>
          </Tabs>
        </motion.div>

        {/* Templates Grid */}
        <motion.div variants={item} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredTemplates.map((template) => (
            <Card 
              key={template.id} 
              className="bg-card border-border hover:border-primary/30 transition-all duration-300 group"
            >
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-base font-semibold text-foreground">
                      {template.name}
                    </CardTitle>
                    <Badge variant="outline" className="mt-1 text-xs border-border text-muted-foreground">
                      {template.category}
                    </Badge>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem>
                        <Eye className="mr-2 h-4 w-4" />
                        Preview
                      </DropdownMenuItem>
                      <DropdownMenuItem>
                        <Edit className="mr-2 h-4 w-4" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem>
                        <Copy className="mr-2 h-4 w-4" />
                        Duplicate
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive">
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Template Content Preview */}
                <div className="p-3 rounded-lg bg-secondary/50 border border-border">
                  <p className="text-sm text-muted-foreground line-clamp-3">
                    {template.content}
                  </p>
                </div>

                {/* Rejection Reason */}
                {template.status === "rejected" && template.rejectionReason && (
                  <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20">
                    <div className="flex items-start gap-2">
                      <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                      <p className="text-xs text-destructive">{template.rejectionReason}</p>
                    </div>
                  </div>
                )}

                {/* Status and Stats */}
                <div className="flex items-center justify-between">
                  {getStatusBadge(template.status)}
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <MessageSquare className="h-3 w-3" />
                      {template.usedIn} campaigns
                    </span>
                  </div>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between pt-3 border-t border-border">
                  <span className="text-xs text-muted-foreground">
                    Last used: {template.lastUsed}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {template.createdAt}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </motion.div>

        {/* Empty State */}
        {filteredTemplates.length === 0 && (
          <motion.div 
            variants={item}
            className="text-center py-12"
          >
            <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-foreground mb-2">No templates found</h3>
            <p className="text-muted-foreground mb-4">
              {searchQuery ? "Try adjusting your search or filters" : "Create your first template to get started"}
            </p>
            <Link href="/dashboard/templates/create">
              <Button className="bg-primary text-primary-foreground">
                <Plus className="h-4 w-4 mr-2" />
                Create Template
              </Button>
            </Link>
          </motion.div>
        )}
      </motion.div>
    </div>
  )
}
