"use client"

import { useState } from "react"
import { motion } from "framer-motion"
import { 
  ArrowLeft,
  ArrowRight,
  Check,
  Users,
  FileText,
  Send,
  Calendar,
  Clock,
  Target,
  Filter,
  Search,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import Link from "next/link"
import { cn } from "@/lib/utils"

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

const steps = [
  { id: 1, name: "Details", icon: FileText },
  { id: 2, name: "Audience", icon: Users },
  { id: 3, name: "Template", icon: Send },
  { id: 4, name: "Schedule", icon: Calendar },
]

const templates = [
  { id: 1, name: "Welcome Message", category: "Onboarding", status: "approved" },
  { id: 2, name: "Order Confirmation", category: "Transactional", status: "approved" },
  { id: 3, name: "Appointment Reminder", category: "Utility", status: "approved" },
  { id: 4, name: "Flash Sale Alert", category: "Marketing", status: "approved" },
]

const audiences = [
  { id: "all", name: "All Contacts", count: 2847, description: "Send to all opted-in contacts" },
  { id: "vip", name: "VIP Customers", count: 342, description: "High-value customers with multiple purchases" },
  { id: "new", name: "New Subscribers", count: 156, description: "Contacts added in the last 30 days" },
  { id: "inactive", name: "Inactive Users", count: 534, description: "No engagement in 60+ days" },
]

export default function CreateCampaignPage() {
  const [currentStep, setCurrentStep] = useState(1)
  const [campaignName, setCampaignName] = useState("")
  const [selectedAudience, setSelectedAudience] = useState("")
  const [selectedTemplate, setSelectedTemplate] = useState("")
  const [scheduleType, setScheduleType] = useState("now")

  const nextStep = () => setCurrentStep(prev => Math.min(prev + 1, 4))
  const prevStep = () => setCurrentStep(prev => Math.max(prev - 1, 1))

  return (
    <div className="min-h-screen p-6 lg:p-8">
      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="max-w-[900px] mx-auto space-y-6"
      >
        {/* Header */}
        <motion.div variants={item} className="flex items-center gap-4">
          <Link href="/dashboard/campaigns">
            <Button variant="ghost" size="icon" className="h-9 w-9">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-semibold text-foreground tracking-tight">Create Campaign</h1>
            <p className="text-muted-foreground text-sm">
              Set up a new WhatsApp marketing campaign.
            </p>
          </div>
        </motion.div>

        {/* Progress Steps */}
        <motion.div variants={item}>
          <div className="flex items-center justify-between">
            {steps.map((step, index) => (
              <div key={step.id} className="flex items-center">
                <div className="flex items-center gap-2">
                  <div className={cn(
                    "w-10 h-10 rounded-full flex items-center justify-center transition-all",
                    currentStep > step.id 
                      ? "bg-accent text-accent-foreground" 
                      : currentStep === step.id
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-muted-foreground"
                  )}>
                    {currentStep > step.id ? (
                      <Check className="h-5 w-5" />
                    ) : (
                      <step.icon className="h-5 w-5" />
                    )}
                  </div>
                  <span className={cn(
                    "text-sm font-medium hidden sm:inline",
                    currentStep >= step.id ? "text-foreground" : "text-muted-foreground"
                  )}>
                    {step.name}
                  </span>
                </div>
                {index < steps.length - 1 && (
                  <div className={cn(
                    "w-12 lg:w-24 h-0.5 mx-2",
                    currentStep > step.id ? "bg-accent" : "bg-border"
                  )} />
                )}
              </div>
            ))}
          </div>
        </motion.div>

        {/* Step Content */}
        <motion.div variants={item}>
          {/* Step 1: Details */}
          {currentStep === 1 && (
            <Card className="bg-card border-border">
              <CardHeader>
                <CardTitle>Campaign Details</CardTitle>
                <CardDescription>Give your campaign a name and description.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Campaign Name</Label>
                  <Input 
                    id="name"
                    placeholder="e.g., Spring Sale 2024"
                    value={campaignName}
                    onChange={(e) => setCampaignName(e.target.value)}
                    className="bg-secondary border-border"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">Description (Optional)</Label>
                  <Input 
                    id="description"
                    placeholder="Brief description of this campaign..."
                    className="bg-secondary border-border"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Campaign Type</Label>
                  <RadioGroup defaultValue="marketing" className="grid grid-cols-2 gap-4">
                    <div className="flex items-center space-x-2 p-4 rounded-lg border border-border bg-secondary/50 cursor-pointer hover:border-primary/30">
                      <RadioGroupItem value="marketing" id="marketing" />
                      <Label htmlFor="marketing" className="cursor-pointer">
                        <span className="font-medium">Marketing</span>
                        <p className="text-xs text-muted-foreground mt-1">Promotional content and offers</p>
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2 p-4 rounded-lg border border-border bg-secondary/50 cursor-pointer hover:border-primary/30">
                      <RadioGroupItem value="transactional" id="transactional" />
                      <Label htmlFor="transactional" className="cursor-pointer">
                        <span className="font-medium">Transactional</span>
                        <p className="text-xs text-muted-foreground mt-1">Order updates and notifications</p>
                      </Label>
                    </div>
                  </RadioGroup>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Step 2: Audience */}
          {currentStep === 2 && (
            <Card className="bg-card border-border">
              <CardHeader>
                <CardTitle>Select Audience</CardTitle>
                <CardDescription>Choose who will receive this campaign.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <RadioGroup value={selectedAudience} onValueChange={setSelectedAudience}>
                  {audiences.map((audience) => (
                    <div 
                      key={audience.id}
                      className={cn(
                        "flex items-center justify-between p-4 rounded-lg border cursor-pointer transition-all",
                        selectedAudience === audience.id 
                          ? "border-primary bg-primary/5" 
                          : "border-border bg-secondary/50 hover:border-primary/30"
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <RadioGroupItem value={audience.id} id={audience.id} />
                        <div>
                          <Label htmlFor={audience.id} className="cursor-pointer font-medium">
                            {audience.name}
                          </Label>
                          <p className="text-xs text-muted-foreground mt-1">{audience.description}</p>
                        </div>
                      </div>
                      <Badge variant="outline" className="border-border">
                        <Users className="h-3 w-3 mr-1" />
                        {audience.count.toLocaleString()}
                      </Badge>
                    </div>
                  ))}
                </RadioGroup>

                <div className="pt-4 border-t border-border">
                  <Button variant="outline" className="gap-2 border-border">
                    <Filter className="h-4 w-4" />
                    Create Custom Segment
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Step 3: Template */}
          {currentStep === 3 && (
            <Card className="bg-card border-border">
              <CardHeader>
                <CardTitle>Choose Template</CardTitle>
                <CardDescription>Select an approved template for your campaign.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input 
                    placeholder="Search templates..." 
                    className="pl-9 bg-secondary border-border"
                  />
                </div>

                <RadioGroup value={selectedTemplate} onValueChange={setSelectedTemplate}>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {templates.map((template) => (
                      <div 
                        key={template.id}
                        className={cn(
                          "p-4 rounded-lg border cursor-pointer transition-all",
                          selectedTemplate === template.id.toString()
                            ? "border-primary bg-primary/5" 
                            : "border-border bg-secondary/50 hover:border-primary/30"
                        )}
                      >
                        <div className="flex items-start gap-3">
                          <RadioGroupItem value={template.id.toString()} id={`template-${template.id}`} className="mt-1" />
                          <div className="flex-1">
                            <Label htmlFor={`template-${template.id}`} className="cursor-pointer font-medium">
                              {template.name}
                            </Label>
                            <div className="flex items-center gap-2 mt-1">
                              <Badge variant="outline" className="text-xs border-border">
                                {template.category}
                              </Badge>
                              <Badge variant="outline" className="text-xs border-accent/30 text-accent bg-accent/10">
                                {template.status}
                              </Badge>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </RadioGroup>

                <div className="pt-4 border-t border-border">
                  <Link href="/dashboard/templates/create">
                    <Button variant="outline" className="gap-2 border-border">
                      <FileText className="h-4 w-4" />
                      Create New Template
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Step 4: Schedule */}
          {currentStep === 4 && (
            <Card className="bg-card border-border">
              <CardHeader>
                <CardTitle>Schedule Campaign</CardTitle>
                <CardDescription>Choose when to send your campaign.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <RadioGroup value={scheduleType} onValueChange={setScheduleType}>
                  <div 
                    className={cn(
                      "flex items-center gap-3 p-4 rounded-lg border cursor-pointer transition-all",
                      scheduleType === "now" 
                        ? "border-primary bg-primary/5" 
                        : "border-border bg-secondary/50 hover:border-primary/30"
                    )}
                  >
                    <RadioGroupItem value="now" id="now" />
                    <div className="flex-1">
                      <Label htmlFor="now" className="cursor-pointer font-medium">Send Now</Label>
                      <p className="text-xs text-muted-foreground mt-1">Campaign will start immediately after review</p>
                    </div>
                    <Send className="h-5 w-5 text-primary" />
                  </div>

                  <div 
                    className={cn(
                      "flex items-center gap-3 p-4 rounded-lg border cursor-pointer transition-all",
                      scheduleType === "schedule" 
                        ? "border-primary bg-primary/5" 
                        : "border-border bg-secondary/50 hover:border-primary/30"
                    )}
                  >
                    <RadioGroupItem value="schedule" id="schedule" />
                    <div className="flex-1">
                      <Label htmlFor="schedule" className="cursor-pointer font-medium">Schedule for Later</Label>
                      <p className="text-xs text-muted-foreground mt-1">Choose a specific date and time</p>
                    </div>
                    <Clock className="h-5 w-5 text-muted-foreground" />
                  </div>
                </RadioGroup>

                {scheduleType === "schedule" && (
                  <div className="grid grid-cols-2 gap-4 pt-4">
                    <div className="space-y-2">
                      <Label>Date</Label>
                      <Input type="date" className="bg-secondary border-border" />
                    </div>
                    <div className="space-y-2">
                      <Label>Time</Label>
                      <Input type="time" className="bg-secondary border-border" />
                    </div>
                  </div>
                )}

                {/* Summary */}
                <div className="p-4 rounded-lg bg-secondary/50 border border-border">
                  <h4 className="font-medium text-foreground mb-3">Campaign Summary</h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Campaign Name:</span>
                      <span className="text-foreground">{campaignName || "Not set"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Audience:</span>
                      <span className="text-foreground">
                        {audiences.find(a => a.id === selectedAudience)?.name || "Not selected"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Template:</span>
                      <span className="text-foreground">
                        {templates.find(t => t.id.toString() === selectedTemplate)?.name || "Not selected"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Schedule:</span>
                      <span className="text-foreground capitalize">{scheduleType === "now" ? "Send Immediately" : "Scheduled"}</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </motion.div>

        {/* Navigation */}
        <motion.div variants={item} className="flex items-center justify-between">
          <Button 
            variant="outline" 
            onClick={prevStep}
            disabled={currentStep === 1}
            className="gap-2 border-border"
          >
            <ArrowLeft className="h-4 w-4" />
            Previous
          </Button>
          
          {currentStep < 4 ? (
            <Button 
              onClick={nextStep}
              className="gap-2 bg-primary text-primary-foreground"
            >
              Next
              <ArrowRight className="h-4 w-4" />
            </Button>
          ) : (
            <Button className="gap-2 bg-accent text-accent-foreground hover:bg-accent/90">
              <Send className="h-4 w-4" />
              Launch Campaign
            </Button>
          )}
        </motion.div>
      </motion.div>
    </div>
  )
}
