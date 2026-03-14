"use client"

import { useState } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { 
  Search, 
  MoreVertical, 
  Phone,
  Star,
  Archive,
  Check,
  CheckCheck,
  Clock,
  Bot,
  Send,
  Paperclip,
  Smile,
  ChevronDown,
  MessageCircle,
  Instagram,
  Facebook,
  Mail,
  Filter,
  Users,
  ArrowLeft,
  MoreHorizontal,
  Tag,
  UserPlus,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

const container = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.03 }
  }
}

const item = {
  hidden: { opacity: 0, x: -10 },
  show: { opacity: 1, x: 0, transition: { duration: 0.3, ease: "easeOut" } }
}

// Channel configuration
const channels = [
  { 
    id: "all", 
    name: "All Channels", 
    icon: MessageCircle, 
    color: "text-foreground",
    bgColor: "bg-foreground/10",
    count: 24 
  },
  { 
    id: "whatsapp", 
    name: "WhatsApp", 
    icon: MessageCircle, 
    color: "text-green-500",
    bgColor: "bg-green-500/10",
    count: 12 
  },
  { 
    id: "instagram", 
    name: "Instagram", 
    icon: Instagram, 
    color: "text-pink-500",
    bgColor: "bg-pink-500/10",
    count: 8 
  },
  { 
    id: "facebook", 
    name: "Facebook Messenger", 
    icon: Facebook, 
    color: "text-blue-500",
    bgColor: "bg-blue-500/10",
    count: 4 
  },
]

const conversations = [
  {
    id: 1,
    name: "Sarah Johnson",
    handle: "@sarahj_designs",
    lastMessage: "Thanks for the quick response! I'll check the order status.",
    time: "2 min ago",
    unread: true,
    starred: true,
    channel: "whatsapp",
    avatar: "SJ",
    status: "online",
    tags: ["VIP", "Returning"],
  },
  {
    id: 2,
    name: "Michael Chen",
    handle: "@mikechen",
    lastMessage: "When will my package arrive? I've been waiting for 3 days now.",
    time: "15 min ago",
    unread: true,
    starred: false,
    channel: "instagram",
    avatar: "MC",
    status: "offline",
    tags: ["Support"],
  },
  {
    id: 3,
    name: "Emily Davis",
    handle: "emily.davis@email.com",
    lastMessage: "Great, I'll schedule a demo for next Tuesday at 2 PM.",
    time: "1 hour ago",
    unread: false,
    starred: true,
    channel: "facebook",
    avatar: "ED",
    status: "online",
    tags: ["Lead"],
  },
  {
    id: 4,
    name: "James Wilson",
    handle: "+1 (555) 456-7890",
    lastMessage: "Can you help me reset my account password?",
    time: "2 hours ago",
    unread: false,
    starred: false,
    channel: "whatsapp",
    avatar: "JW",
    status: "offline",
    tags: [],
  },
  {
    id: 5,
    name: "Lisa Anderson",
    handle: "@lisa.anderson",
    lastMessage: "I'd like to upgrade my subscription plan.",
    time: "3 hours ago",
    unread: true,
    starred: false,
    channel: "instagram",
    avatar: "LA",
    status: "online",
    tags: ["Upgrade"],
  },
  {
    id: 6,
    name: "David Kim",
    handle: "david.kim.official",
    lastMessage: "Is there a bulk discount available for orders over 100 units?",
    time: "4 hours ago",
    unread: false,
    starred: false,
    channel: "facebook",
    avatar: "DK",
    status: "offline",
    tags: ["B2B"],
  },
  {
    id: 7,
    name: "Amanda Roberts",
    handle: "+1 (555) 789-0123",
    lastMessage: "The product quality is amazing! Will definitely order again.",
    time: "5 hours ago",
    unread: false,
    starred: true,
    channel: "whatsapp",
    avatar: "AR",
    status: "online",
    tags: ["VIP"],
  },
]

const getChannelIcon = (channelId: string) => {
  const channel = channels.find(c => c.id === channelId)
  return channel || channels[0]
}

const messages = [
  {
    id: 1,
    sender: "customer",
    text: "Hi, I placed an order last week and haven't received any shipping updates. Order #12345",
    time: "10:30 AM",
    status: "read",
  },
  {
    id: 2,
    sender: "bot",
    text: "Hello Sarah! I'd be happy to help you track your order. Let me look that up for you.",
    time: "10:30 AM",
    isBot: true,
    status: "delivered",
  },
  {
    id: 3,
    sender: "bot",
    text: "I found your order #12345. It was shipped yesterday and is currently in transit. The estimated delivery is tomorrow between 2-6 PM.",
    time: "10:31 AM",
    isBot: true,
    status: "delivered",
  },
  {
    id: 4,
    sender: "customer",
    text: "Oh great! Is there a tracking number I can use?",
    time: "10:32 AM",
    status: "read",
  },
  {
    id: 5,
    sender: "bot",
    text: "Yes! Your tracking number is: 1Z999AA10123456784. You can track it here: https://track.shipping.com/1Z999AA10123456784",
    time: "10:32 AM",
    isBot: true,
    status: "delivered",
  },
  {
    id: 6,
    sender: "customer",
    text: "Thanks for the quick response! I'll check the order status.",
    time: "10:33 AM",
    status: "read",
  },
]

export default function InboxPage() {
  const [selectedChannel, setSelectedChannel] = useState("all")
  const [selectedConversation, setSelectedConversation] = useState(conversations[0])
  const [filter, setFilter] = useState("all")
  const [messageInput, setMessageInput] = useState("")
  const [showChannelPanel, setShowChannelPanel] = useState(true)

  const filteredConversations = conversations.filter(conv => {
    const channelMatch = selectedChannel === "all" || conv.channel === selectedChannel
    const filterMatch = filter === "all" || 
      (filter === "unread" && conv.unread) || 
      (filter === "starred" && conv.starred)
    return channelMatch && filterMatch
  })

  const currentChannel = getChannelIcon(selectedConversation.channel)
  const ChannelIcon = currentChannel.icon

  return (
    <TooltipProvider>
      <div className="h-screen flex">
        {/* Channel Selector Panel */}
        <AnimatePresence>
          {showChannelPanel && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 240, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="border-r border-border flex flex-col bg-card overflow-hidden"
            >
              <div className="p-4 border-b border-border">
                <div className="flex items-center justify-between mb-1">
                  <h2 className="text-lg font-semibold text-foreground">Channels</h2>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground"
                    onClick={() => setShowChannelPanel(false)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">Manage all your conversations</p>
              </div>

              <ScrollArea className="flex-1 p-2">
                <div className="space-y-1">
                  {channels.map((channel) => {
                    const Icon = channel.icon
                    const isActive = selectedChannel === channel.id
                    const unreadCount = channel.id === "all" 
                      ? conversations.filter(c => c.unread).length
                      : conversations.filter(c => c.channel === channel.id && c.unread).length

                    return (
                      <button
                        key={channel.id}
                        onClick={() => setSelectedChannel(channel.id)}
                        className={cn(
                          "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200",
                          isActive
                            ? "bg-primary/10 border border-primary/20"
                            : "hover:bg-secondary border border-transparent"
                        )}
                      >
                        <div className={cn("p-1.5 rounded-md", channel.bgColor)}>
                          <Icon className={cn("h-4 w-4", channel.color)} />
                        </div>
                        <div className="flex-1 text-left">
                          <p className={cn(
                            "text-sm",
                            isActive ? "text-foreground font-medium" : "text-muted-foreground"
                          )}>
                            {channel.name}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          {unreadCount > 0 && (
                            <Badge className="h-5 min-w-[20px] px-1.5 bg-primary text-primary-foreground text-xs">
                              {unreadCount}
                            </Badge>
                          )}
                          <span className="text-xs text-muted-foreground">{channel.count}</span>
                        </div>
                      </button>
                    )
                  })}
                </div>

                <div className="mt-6 pt-4 border-t border-border">
                  <p className="px-3 text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                    Quick Filters
                  </p>
                  <div className="space-y-1">
                    {[
                      { id: "all", label: "All Messages", icon: MessageCircle },
                      { id: "unread", label: "Unread", icon: Mail },
                      { id: "starred", label: "Starred", icon: Star },
                    ].map((f) => {
                      const Icon = f.icon
                      const isActive = filter === f.id
                      return (
                        <button
                          key={f.id}
                          onClick={() => setFilter(f.id)}
                          className={cn(
                            "w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-200 text-sm",
                            isActive
                              ? "bg-secondary text-foreground"
                              : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                          )}
                        >
                          <Icon className="h-4 w-4" />
                          <span>{f.label}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="mt-6 pt-4 border-t border-border">
                  <p className="px-3 text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                    Team Members
                  </p>
                  <div className="px-3 flex -space-x-2">
                    {["JD", "AK", "MR", "TS"].map((initials, i) => (
                      <Tooltip key={i}>
                        <TooltipTrigger asChild>
                          <Avatar className="h-8 w-8 border-2 border-card cursor-pointer hover:z-10 transition-transform hover:scale-110">
                            <AvatarFallback className="bg-secondary text-foreground text-xs">
                              {initials}
                            </AvatarFallback>
                          </Avatar>
                        </TooltipTrigger>
                        <TooltipContent>Team Member {i + 1}</TooltipContent>
                      </Tooltip>
                    ))}
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 rounded-full border-2 border-dashed border-border"
                    >
                      <UserPlus className="h-3 w-3 text-muted-foreground" />
                    </Button>
                  </div>
                </div>
              </ScrollArea>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Conversations List */}
        <div className="w-80 lg:w-96 border-r border-border flex flex-col bg-card">
          {/* Header */}
          <div className="p-4 border-b border-border">
            <div className="flex items-center gap-2 mb-4">
              {!showChannelPanel && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground shrink-0"
                  onClick={() => setShowChannelPanel(true)}
                >
                  <Filter className="h-4 w-4" />
                </Button>
              )}
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <h1 className="text-xl font-semibold text-foreground">
                    {channels.find(c => c.id === selectedChannel)?.name || "Inbox"}
                  </h1>
                </div>
              </div>
              <Badge className="bg-primary/10 text-primary border-0">
                {filteredConversations.filter(c => c.unread).length} new
              </Badge>
            </div>
            
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input 
                placeholder="Search conversations..." 
                className="pl-9 bg-secondary border-border"
              />
            </div>
          </div>

          {/* Conversations */}
          <ScrollArea className="flex-1">
            <motion.div
              variants={container}
              initial="hidden"
              animate="show"
              className="p-2"
            >
              {filteredConversations.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="h-12 w-12 rounded-full bg-secondary flex items-center justify-center mb-3">
                    <MessageCircle className="h-6 w-6 text-muted-foreground" />
                  </div>
                  <p className="text-sm text-muted-foreground">No conversations found</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Try adjusting your filters
                  </p>
                </div>
              ) : (
                filteredConversations.map((conv) => {
                  const channelInfo = getChannelIcon(conv.channel)
                  const ConvChannelIcon = channelInfo.icon
                  
                  return (
                    <motion.button
                      key={conv.id}
                      variants={item}
                      onClick={() => setSelectedConversation(conv)}
                      className={cn(
                        "w-full p-3 rounded-lg flex items-start gap-3 text-left transition-all duration-200 mb-1",
                        selectedConversation.id === conv.id
                          ? "bg-primary/10 border border-primary/20"
                          : "hover:bg-secondary border border-transparent"
                      )}
                    >
                      <div className="relative">
                        <Avatar className="h-10 w-10 bg-secondary">
                          <AvatarFallback className="bg-secondary text-foreground text-sm">
                            {conv.avatar}
                          </AvatarFallback>
                        </Avatar>
                        <div className={cn(
                          "absolute -bottom-0.5 -right-0.5 p-0.5 rounded-full",
                          channelInfo.bgColor
                        )}>
                          <ConvChannelIcon className={cn("h-3 w-3", channelInfo.color)} />
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-0.5">
                          <div className="flex items-center gap-2">
                            <span className={cn(
                              "text-sm truncate",
                              conv.unread ? "font-semibold text-foreground" : "text-foreground"
                            )}>
                              {conv.name}
                            </span>
                            {conv.starred && <Star className="h-3 w-3 fill-primary text-primary shrink-0" />}
                          </div>
                          <span className="text-xs text-muted-foreground shrink-0">{conv.time}</span>
                        </div>
                        <p className="text-xs text-muted-foreground truncate mb-1">
                          {conv.handle}
                        </p>
                        <p className={cn(
                          "text-sm truncate",
                          conv.unread ? "text-foreground" : "text-muted-foreground"
                        )}>
                          {conv.lastMessage}
                        </p>
                        {conv.tags.length > 0 && (
                          <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                            {conv.tags.map((tag) => (
                              <Badge 
                                key={tag} 
                                variant="outline" 
                                className="text-[10px] px-1.5 py-0 border-border h-4"
                              >
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                      {conv.unread && (
                        <div className="w-2 h-2 rounded-full bg-primary mt-2 shrink-0" />
                      )}
                    </motion.button>
                  )
                })
              )}
            </motion.div>
          </ScrollArea>
        </div>

        {/* Chat View */}
        <div className="flex-1 flex flex-col bg-background">
          {/* Chat Header */}
          <div className="h-16 border-b border-border px-6 flex items-center justify-between bg-card">
            <div className="flex items-center gap-3">
              <div className="relative">
                <Avatar className="h-10 w-10 bg-secondary">
                  <AvatarFallback className="bg-secondary text-foreground">
                    {selectedConversation.avatar}
                  </AvatarFallback>
                </Avatar>
                <div className={cn(
                  "absolute -bottom-0.5 -right-0.5 p-0.5 rounded-full",
                  currentChannel.bgColor
                )}>
                  <ChannelIcon className={cn("h-3 w-3", currentChannel.color)} />
                </div>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-foreground">{selectedConversation.name}</h2>
                  <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0 border-0", currentChannel.bgColor, currentChannel.color)}>
                    {currentChannel.name}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  {selectedConversation.handle}
                  {selectedConversation.status === "online" && (
                    <span className="flex items-center gap-1 text-accent">
                      <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                      Online
                    </span>
                  )}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground">
                    <Tag className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Add Tag</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground">
                    <Star className={cn("h-4 w-4", selectedConversation.starred && "fill-primary text-primary")} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Star Conversation</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground">
                    <Archive className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Archive</TooltipContent>
              </Tooltip>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground">
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem>
                    <Users className="h-4 w-4 mr-2" />
                    View Contact
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <Tag className="h-4 w-4 mr-2" />
                    Manage Tags
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive">
                    Block Contact
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Messages */}
          <ScrollArea className="flex-1 p-6">
            <div className="max-w-3xl mx-auto space-y-4">
              {/* Date Separator */}
              <div className="flex items-center gap-4 py-2">
                <div className="flex-1 h-px bg-border" />
                <span className="text-xs text-muted-foreground">Today</span>
                <div className="flex-1 h-px bg-border" />
              </div>

              {messages.map((message) => (
                <motion.div
                  key={message.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={cn(
                    "flex",
                    message.sender === "customer" ? "justify-start" : "justify-end"
                  )}
                >
                  <div className={cn(
                    "max-w-[70%] rounded-lg p-3 group relative",
                    message.sender === "customer" 
                      ? "bg-secondary text-foreground" 
                      : message.isBot 
                        ? "bg-primary/10 text-foreground border border-primary/20"
                        : "bg-primary/20 text-foreground"
                  )}>
                    {message.isBot && (
                      <div className="flex items-center gap-1 text-xs text-primary mb-1.5">
                        <Bot className="h-3 w-3" />
                        <span className="font-medium">AI Agent</span>
                      </div>
                    )}
                    <p className="text-sm leading-relaxed">{message.text}</p>
                    <div className="flex items-center justify-end gap-1.5 mt-1.5">
                      <span className="text-[10px] text-muted-foreground">{message.time}</span>
                      {message.sender !== "customer" && (
                        message.status === "read" ? (
                          <CheckCheck className="h-3 w-3 text-accent" />
                        ) : (
                          <Check className="h-3 w-3 text-muted-foreground" />
                        )
                      )}
                    </div>
                    
                    {/* Hover actions */}
                    <div className="absolute -top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <div className="flex items-center gap-0.5 bg-card border border-border rounded-md shadow-lg p-0.5">
                        <Button variant="ghost" size="icon" className="h-6 w-6">
                          <Smile className="h-3 w-3" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-6 w-6">
                          <MoreHorizontal className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          </ScrollArea>

          {/* Message Input */}
          <div className="border-t border-border p-4 bg-card">
            <div className="max-w-3xl mx-auto">
              <div className="flex items-center gap-2 mb-3">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="gap-1.5 text-xs border-border h-7">
                      <Bot className="h-3 w-3 text-primary" />
                      AI Agent Active
                      <ChevronDown className="h-3 w-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem>
                      <Bot className="h-4 w-4 mr-2 text-primary" />
                      AI Agent Active
                    </DropdownMenuItem>
                    <DropdownMenuItem>
                      <Users className="h-4 w-4 mr-2" />
                      Manual Mode
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button variant="ghost" size="sm" className="gap-1.5 text-xs text-muted-foreground h-7">
                  <Clock className="h-3 w-3" />
                  Schedule
                </Button>
                <div className="flex-1" />
                <Badge variant="outline" className={cn("text-[10px] h-5 border-0", currentChannel.bgColor, currentChannel.color)}>
                  Replying via {currentChannel.name}
                </Badge>
              </div>
              <div className="flex items-center gap-2 bg-secondary rounded-lg p-1">
                <Button variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground shrink-0 hover:text-foreground">
                  <Paperclip className="h-4 w-4" />
                </Button>
                <Input
                  placeholder={`Message ${selectedConversation.name}...`}
                  value={messageInput}
                  onChange={(e) => setMessageInput(e.target.value)}
                  className="flex-1 bg-transparent border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                />
                <Button variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground shrink-0 hover:text-foreground">
                  <Smile className="h-4 w-4" />
                </Button>
                <Button size="icon" className="h-9 w-9 bg-primary text-primary-foreground shrink-0 hover:bg-primary/90">
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}
