"use client"

import { useState } from "react"
import { motion } from "framer-motion"
import { 
  ArrowLeft,
  FileText,
  Eye,
  Save,
  Send,
  Plus,
  Trash2,
  Info,
  MessageSquare,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
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

export default function CreateTemplatePage() {
  const [templateName, setTemplateName] = useState("")
  const [category, setCategory] = useState("")
  const [content, setContent] = useState("")
  const [variables, setVariables] = useState<string[]>([])

  const addVariable = () => {
    const newVar = `{{${variables.length + 1}}}`
    setContent(prev => prev + newVar)
    setVariables(prev => [...prev, `Variable ${prev.length + 1}`])
  }

  const previewContent = () => {
    let preview = content
    variables.forEach((varName, index) => {
      preview = preview.replace(`{{${index + 1}}}`, `[${varName}]`)
    })
    return preview
  }

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
            <h1 className="text-2xl font-semibold text-foreground tracking-tight">Create Template</h1>
            <p className="text-muted-foreground text-sm">
              Create a new WhatsApp message template for approval.
            </p>
          </div>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Form */}
          <motion.div variants={item} className="lg:col-span-3 space-y-6">
            <Card className="bg-card border-border">
              <CardHeader>
                <CardTitle className="text-base">Template Details</CardTitle>
                <CardDescription>Basic information about your template.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Template Name</Label>
                  <Input 
                    id="name"
                    placeholder="e.g., Order Confirmation"
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    className="bg-secondary border-border"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="category">Category</Label>
                  <Select value={category} onValueChange={setCategory}>
                    <SelectTrigger className="bg-secondary border-border">
                      <SelectValue placeholder="Select category" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="transactional">Transactional</SelectItem>
                      <SelectItem value="marketing">Marketing</SelectItem>
                      <SelectItem value="utility">Utility</SelectItem>
                      <SelectItem value="onboarding">Onboarding</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-card border-border">
              <CardHeader>
                <CardTitle className="text-base">Message Content</CardTitle>
                <CardDescription>Write your template message. Use variables for dynamic content.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="content">Message Body</Label>
                    <Button 
                      variant="outline" 
                      size="sm" 
                      className="gap-1 border-border"
                      onClick={addVariable}
                    >
                      <Plus className="h-3 w-3" />
                      Add Variable
                    </Button>
                  </div>
                  <Textarea 
                    id="content"
                    placeholder="Hi {{1}}! Your order has been confirmed..."
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    className="min-h-[150px] bg-secondary border-border"
                  />
                  <p className="text-xs text-muted-foreground">
                    {content.length}/1024 characters
                  </p>
                </div>

                {/* Variables */}
                {variables.length > 0 && (
                  <div className="space-y-2">
                    <Label>Variables</Label>
                    <div className="space-y-2">
                      {variables.map((varName, index) => (
                        <div key={index} className="flex items-center gap-2">
                          <Badge variant="outline" className="border-primary/30 text-primary bg-primary/10">
                            {`{{${index + 1}}}`}
                          </Badge>
                          <Input 
                            value={varName}
                            onChange={(e) => {
                              const newVars = [...variables]
                              newVars[index] = e.target.value
                              setVariables(newVars)
                            }}
                            placeholder="Variable description"
                            className="flex-1 bg-secondary border-border h-8 text-sm"
                          />
                          <Button 
                            variant="ghost" 
                            size="icon" 
                            className="h-8 w-8 text-muted-foreground hover:text-destructive"
                            onClick={() => setVariables(prev => prev.filter((_, i) => i !== index))}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Info Card */}
            <Card className="bg-primary/5 border-primary/20">
              <CardContent className="p-4">
                <div className="flex gap-3">
                  <Info className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">Template Guidelines</p>
                    <ul className="text-xs text-muted-foreground space-y-1">
                      <li>Templates must comply with WhatsApp's Business Policy</li>
                      <li>Marketing templates require user opt-in</li>
                      <li>Avoid promotional language in transactional templates</li>
                      <li>Review typically takes 24-48 hours</li>
                    </ul>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>

          {/* Preview */}
          <motion.div variants={item} className="lg:col-span-2">
            <Card className="bg-card border-border sticky top-6">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Eye className="h-4 w-4 text-primary" />
                  <CardTitle className="text-base">Preview</CardTitle>
                </div>
                <CardDescription>How your message will appear.</CardDescription>
              </CardHeader>
              <CardContent>
                {/* Phone Mockup */}
                <div className="bg-secondary rounded-2xl p-4 border border-border">
                  <div className="flex items-center gap-2 pb-3 border-b border-border mb-3">
                    <div className="w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center">
                      <MessageSquare className="h-4 w-4 text-accent" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">Your Business</p>
                      <p className="text-xs text-muted-foreground">WhatsApp Business</p>
                    </div>
                  </div>
                  
                  <div className="bg-card rounded-lg p-3 border border-border">
                    <p className="text-sm text-foreground whitespace-pre-wrap">
                      {previewContent() || "Your message preview will appear here..."}
                    </p>
                    <p className="text-xs text-muted-foreground text-right mt-2">
                      12:00 PM
                    </p>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex gap-2 mt-4">
                  <Button variant="outline" className="flex-1 gap-2 border-border">
                    <Save className="h-4 w-4" />
                    Save Draft
                  </Button>
                  <Button className="flex-1 gap-2 bg-primary text-primary-foreground">
                    <Send className="h-4 w-4" />
                    Submit
                  </Button>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </div>
      </motion.div>
    </div>
  )
}
