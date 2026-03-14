"use client"

import { useState } from "react"
import { motion } from "framer-motion"
import { 
  Bot, 
  Plus, 
  MoreVertical, 
  Play, 
  Pause, 
  Trash2, 
  Edit, 
  Copy, 
  MessageSquare,
  Users,
  TrendingUp,
  Clock,
  Zap,
  Settings,
  ExternalLink,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"

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

const bots = [
  {
    id: 1,
    name: "Customer Support Bot",
    description: "Handles common customer inquiries and support tickets",
    status: "active",
    conversations: 1247,
    responseRate: 98.5,
    avgResponseTime: "< 1 min",
    lastActive: "2 minutes ago",
    triggers: ["WhatsApp", "Website Chat"],
    color: "bg-accent",
  },
  {
    id: 2,
    name: "Sales Assistant",
    description: "Qualifies leads and schedules demos with potential customers",
    status: "active",
    conversations: 856,
    responseRate: 94.2,
    avgResponseTime: "< 2 min",
    lastActive: "5 minutes ago",
    triggers: ["WhatsApp", "SMS"],
    color: "bg-primary",
  },
  {
    id: 3,
    name: "Order Status Bot",
    description: "Provides real-time order tracking and shipping updates",
    status: "paused",
    conversations: 2341,
    responseRate: 99.1,
    avgResponseTime: "< 30 sec",
    lastActive: "1 hour ago",
    triggers: ["WhatsApp"],
    color: "bg-blue-500",
  },
  {
    id: 4,
    name: "Appointment Scheduler",
    description: "Books appointments and sends reminders to customers",
    status: "active",
    conversations: 534,
    responseRate: 96.8,
    avgResponseTime: "< 1 min",
    lastActive: "10 minutes ago",
    triggers: ["WhatsApp", "Email"],
    color: "bg-purple-500",
  },
]

export default function BotsPage() {
  const [botStates, setBotStates] = useState<Record<number, boolean>>(
    Object.fromEntries(bots.map(bot => [bot.id, bot.status === "active"]))
  )

  const toggleBot = (id: number) => {
    setBotStates(prev => ({ ...prev, [id]: !prev[id] }))
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
            <h1 className="text-3xl font-semibold text-foreground tracking-tight">My Bots</h1>
            <p className="text-muted-foreground mt-1">
              Manage your AI agents and automation workflows.
            </p>
          </div>
          <Button className="bg-primary text-primary-foreground hover:bg-primary/90 gap-2 shrink-0">
            <Plus className="h-4 w-4" />
            Create Bot
          </Button>
        </motion.div>

        {/* Stats Row */}
        <motion.div variants={item} className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <Card className="bg-card border-border">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">Total Bots</p>
                  <p className="text-2xl font-semibold text-foreground mt-1">{bots.length}</p>
                </div>
                <div className="p-2 rounded-md bg-primary/10">
                  <Bot className="h-5 w-5 text-primary" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="bg-card border-border">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">Active</p>
                  <p className="text-2xl font-semibold text-foreground mt-1">{bots.filter(b => b.status === "active").length}</p>
                </div>
                <div className="p-2 rounded-md bg-accent/10">
                  <Zap className="h-5 w-5 text-accent" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="bg-card border-border">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">Total Conversations</p>
                  <p className="text-2xl font-semibold text-foreground mt-1">
                    {bots.reduce((acc, bot) => acc + bot.conversations, 0).toLocaleString()}
                  </p>
                </div>
                <div className="p-2 rounded-md bg-blue-500/10">
                  <MessageSquare className="h-5 w-5 text-blue-500" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="bg-card border-border">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">Avg Response Rate</p>
                  <p className="text-2xl font-semibold text-foreground mt-1">
                    {(bots.reduce((acc, bot) => acc + bot.responseRate, 0) / bots.length).toFixed(1)}%
                  </p>
                </div>
                <div className="p-2 rounded-md bg-purple-500/10">
                  <TrendingUp className="h-5 w-5 text-purple-500" />
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Bots Grid */}
        <motion.div variants={item} className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {bots.map((bot) => (
            <Card 
              key={bot.id} 
              className="bg-card border-border hover:border-primary/30 transition-all duration-300 group"
            >
              <CardContent className="p-6">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <Avatar className={`h-12 w-12 ${bot.color}`}>
                      <AvatarFallback className="bg-transparent text-primary-foreground">
                        <Bot className="h-6 w-6" />
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <h3 className="text-lg font-semibold text-foreground">{bot.name}</h3>
                      <p className="text-sm text-muted-foreground">{bot.description}</p>
                    </div>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground">
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem>
                        <Edit className="mr-2 h-4 w-4" />
                        Edit Bot
                      </DropdownMenuItem>
                      <DropdownMenuItem>
                        <Copy className="mr-2 h-4 w-4" />
                        Duplicate
                      </DropdownMenuItem>
                      <DropdownMenuItem>
                        <Settings className="mr-2 h-4 w-4" />
                        Settings
                      </DropdownMenuItem>
                      <DropdownMenuItem>
                        <ExternalLink className="mr-2 h-4 w-4" />
                        View Logs
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive">
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                {/* Triggers */}
                <div className="flex flex-wrap gap-2 mb-4">
                  {bot.triggers.map((trigger) => (
                    <Badge key={trigger} variant="outline" className="border-border text-muted-foreground">
                      {trigger}
                    </Badge>
                  ))}
                </div>

                {/* Stats */}
                <div className="grid grid-cols-3 gap-4 p-4 rounded-lg bg-secondary/50 mb-4">
                  <div className="text-center">
                    <div className="flex items-center justify-center gap-1 text-muted-foreground mb-1">
                      <MessageSquare className="h-3 w-3" />
                      <span className="text-xs">Conversations</span>
                    </div>
                    <p className="text-lg font-semibold text-foreground">{bot.conversations.toLocaleString()}</p>
                  </div>
                  <div className="text-center border-x border-border">
                    <div className="flex items-center justify-center gap-1 text-muted-foreground mb-1">
                      <TrendingUp className="h-3 w-3" />
                      <span className="text-xs">Response Rate</span>
                    </div>
                    <p className="text-lg font-semibold text-foreground">{bot.responseRate}%</p>
                  </div>
                  <div className="text-center">
                    <div className="flex items-center justify-center gap-1 text-muted-foreground mb-1">
                      <Clock className="h-3 w-3" />
                      <span className="text-xs">Avg Time</span>
                    </div>
                    <p className="text-lg font-semibold text-foreground">{bot.avgResponseTime}</p>
                  </div>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${botStates[bot.id] ? 'bg-accent' : 'bg-muted-foreground'}`} />
                    <span className="text-sm text-muted-foreground">
                      {botStates[bot.id] ? 'Active' : 'Paused'} · {bot.lastActive}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <Switch 
                      checked={botStates[bot.id]} 
                      onCheckedChange={() => toggleBot(bot.id)}
                    />
                    <Button 
                      variant="outline" 
                      size="sm"
                      className="gap-2 border-border"
                    >
                      {botStates[bot.id] ? (
                        <>
                          <Pause className="h-3 w-3" />
                          Pause
                        </>
                      ) : (
                        <>
                          <Play className="h-3 w-3" />
                          Start
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </motion.div>
      </motion.div>
    </div>
  )
}
