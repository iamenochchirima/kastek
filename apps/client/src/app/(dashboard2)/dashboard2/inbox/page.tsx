"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search,
  MoreVertical,
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
  MoreHorizontal,
  Tag,
  UserPlus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const container = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.03 },
  },
};

const item = {
  hidden: { opacity: 0, x: -10 },
  show: { opacity: 1, x: 0, transition: { duration: 0.3, ease: "easeOut" as const } },
};

const channels = [
  {
    id: "all",
    name: "All Channels",
    icon: MessageCircle,
    color: "text-foreground",
    bgColor: "bg-foreground/10",
    count: 24,
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    icon: MessageCircle,
    color: "text-green-500",
    bgColor: "bg-green-500/10",
    count: 12,
  },
  {
    id: "instagram",
    name: "Instagram",
    icon: Instagram,
    color: "text-pink-500",
    bgColor: "bg-pink-500/10",
    count: 8,
  },
  {
    id: "facebook",
    name: "Facebook Messenger",
    icon: Facebook,
    color: "text-blue-500",
    bgColor: "bg-blue-500/10",
    count: 4,
  },
];

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
];

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
];

const getChannelIcon = (channelId: string) => {
  const channel = channels.find((channelItem) => channelItem.id === channelId);
  return channel || channels[0];
};

export default function Dashboard2InboxPage() {
  const [selectedChannel, setSelectedChannel] = useState("all");
  const [selectedConversation, setSelectedConversation] = useState(conversations[0]);
  const [filter, setFilter] = useState("all");
  const [messageInput, setMessageInput] = useState("");
  const [showChannelPanel, setShowChannelPanel] = useState(true);

  const filteredConversations = conversations.filter((conversation) => {
    const channelMatch = selectedChannel === "all" || conversation.channel === selectedChannel;
    const filterMatch =
      filter === "all" ||
      (filter === "unread" && conversation.unread) ||
      (filter === "starred" && conversation.starred);
    return channelMatch && filterMatch;
  });

  const currentChannel = getChannelIcon(selectedConversation.channel);
  const ChannelIcon = currentChannel.icon;

  return (
    <TooltipProvider>
      <div className="flex h-screen">
        <AnimatePresence>
          {showChannelPanel && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 240, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="flex flex-col overflow-hidden border-r border-border bg-card"
            >
              <div className="border-b border-border p-4">
                <div className="mb-1 flex items-center justify-between">
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
                    const Icon = channel.icon;
                    const isActive = selectedChannel === channel.id;
                    const unreadCount =
                      channel.id === "all"
                        ? conversations.filter((conversation) => conversation.unread).length
                        : conversations.filter(
                            (conversation) =>
                              conversation.channel === channel.id && conversation.unread,
                          ).length;

                    return (
                      <button
                        key={channel.id}
                        onClick={() => setSelectedChannel(channel.id)}
                        className={cn(
                          "w-full rounded-lg border px-3 py-2.5 transition-all duration-200",
                          "flex items-center gap-3",
                          isActive
                            ? "border-primary/20 bg-primary/10"
                            : "border-transparent hover:bg-secondary",
                        )}
                      >
                        <div className={cn("rounded-md p-1.5", channel.bgColor)}>
                          <Icon className={cn("h-4 w-4", channel.color)} />
                        </div>
                        <div className="flex-1 text-left">
                          <p
                            className={cn(
                              "text-sm",
                              isActive
                                ? "font-medium text-foreground"
                                : "text-muted-foreground",
                            )}
                          >
                            {channel.name}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          {unreadCount > 0 ? (
                            <Badge className="h-5 min-w-[20px] border-0 bg-primary px-1.5 text-xs text-primary-foreground">
                              {unreadCount}
                            </Badge>
                          ) : null}
                          <span className="text-xs text-muted-foreground">{channel.count}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="mt-6 border-t border-border pt-4">
                  <p className="mb-2 px-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Quick Filters
                  </p>
                  <div className="space-y-1">
                    {[
                      { id: "all", label: "All Messages", icon: MessageCircle },
                      { id: "unread", label: "Unread", icon: Mail },
                      { id: "starred", label: "Starred", icon: Star },
                    ].map((filterItem) => {
                      const Icon = filterItem.icon;
                      const isActive = filter === filterItem.id;
                      return (
                        <button
                          key={filterItem.id}
                          onClick={() => setFilter(filterItem.id)}
                          className={cn(
                            "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all duration-200",
                            isActive
                              ? "bg-secondary text-foreground"
                              : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
                          )}
                        >
                          <Icon className="h-4 w-4" />
                          <span>{filterItem.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="mt-6 border-t border-border pt-4">
                  <p className="mb-2 px-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Team Members
                  </p>
                  <div className="flex -space-x-2 px-3">
                    {["JD", "AK", "MR", "TS"].map((initials, index) => (
                      <Tooltip key={index}>
                        <TooltipTrigger asChild>
                          <Avatar className="h-8 w-8 cursor-pointer border-2 border-card transition-transform hover:z-10 hover:scale-110">
                            <AvatarFallback className="bg-secondary text-xs text-foreground">
                              {initials}
                            </AvatarFallback>
                          </Avatar>
                        </TooltipTrigger>
                        <TooltipContent>Team Member {index + 1}</TooltipContent>
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

        <div className="flex w-80 flex-col border-r border-border bg-card lg:w-96">
          <div className="border-b border-border p-4">
            <div className="mb-4 flex items-center gap-2">
              {!showChannelPanel ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-muted-foreground"
                  onClick={() => setShowChannelPanel(true)}
                >
                  <Filter className="h-4 w-4" />
                </Button>
              ) : null}
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <h1 className="text-xl font-semibold text-foreground">
                    {channels.find((channel) => channel.id === selectedChannel)?.name || "Inbox"}
                  </h1>
                </div>
              </div>
              <Badge className="border-0 bg-primary/10 text-primary">
                {filteredConversations.filter((conversation) => conversation.unread).length} new
              </Badge>
            </div>

            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search conversations..."
                className="border-border bg-secondary pl-9"
              />
            </div>
          </div>

          <ScrollArea className="flex-1">
            <motion.div
              variants={container}
              initial="hidden"
              animate="show"
              className="p-2"
            >
              {filteredConversations.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
                    <MessageCircle className="h-6 w-6 text-muted-foreground" />
                  </div>
                  <p className="text-sm text-muted-foreground">No conversations found</p>
                  <p className="mt-1 text-xs text-muted-foreground">Try adjusting your filters</p>
                </div>
              ) : (
                filteredConversations.map((conversation) => {
                  const channelInfo = getChannelIcon(conversation.channel);
                  const ConversationChannelIcon = channelInfo.icon;

                  return (
                    <motion.button
                      key={conversation.id}
                      variants={item}
                      onClick={() => setSelectedConversation(conversation)}
                      className={cn(
                        "mb-1 flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-all duration-200",
                        selectedConversation.id === conversation.id
                          ? "border-primary/20 bg-primary/10"
                          : "border-transparent hover:bg-secondary",
                      )}
                    >
                      <div className="relative">
                        <Avatar className="h-10 w-10 bg-secondary">
                          <AvatarFallback className="bg-secondary text-sm text-foreground">
                            {conversation.avatar}
                          </AvatarFallback>
                        </Avatar>
                        <div
                          className={cn(
                            "absolute -bottom-0.5 -right-0.5 rounded-full p-0.5",
                            channelInfo.bgColor,
                          )}
                        >
                          <ConversationChannelIcon
                            className={cn("h-3 w-3", channelInfo.color)}
                          />
                        </div>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="mb-0.5 flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span
                              className={cn(
                                "truncate text-sm",
                                conversation.unread
                                  ? "font-semibold text-foreground"
                                  : "text-foreground",
                              )}
                            >
                              {conversation.name}
                            </span>
                            {conversation.starred ? (
                              <Star className="h-3 w-3 shrink-0 fill-primary text-primary" />
                            ) : null}
                          </div>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {conversation.time}
                          </span>
                        </div>
                        <p className="mb-1 truncate text-xs text-muted-foreground">
                          {conversation.handle}
                        </p>
                        <p
                          className={cn(
                            "truncate text-sm",
                            conversation.unread
                              ? "text-foreground"
                              : "text-muted-foreground",
                          )}
                        >
                          {conversation.lastMessage}
                        </p>
                        {conversation.tags.length > 0 ? (
                          <div className="mt-1.5 flex flex-wrap items-center gap-1">
                            {conversation.tags.map((tag) => (
                              <Badge
                                key={tag}
                                variant="outline"
                                className="h-4 border-border px-1.5 py-0 text-[10px]"
                              >
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        ) : null}
                      </div>
                      {conversation.unread ? (
                        <div className="mt-2 h-2 w-2 shrink-0 rounded-full bg-primary" />
                      ) : null}
                    </motion.button>
                  );
                })
              )}
            </motion.div>
          </ScrollArea>
        </div>

        <div className="flex flex-1 flex-col bg-background">
          <div className="flex h-16 items-center justify-between border-b border-border bg-card px-6">
            <div className="flex items-center gap-3">
              <div className="relative">
                <Avatar className="h-10 w-10 bg-secondary">
                  <AvatarFallback className="bg-secondary text-foreground">
                    {selectedConversation.avatar}
                  </AvatarFallback>
                </Avatar>
                <div
                  className={cn(
                    "absolute -bottom-0.5 -right-0.5 rounded-full p-0.5",
                    currentChannel.bgColor,
                  )}
                >
                  <ChannelIcon className={cn("h-3 w-3", currentChannel.color)} />
                </div>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-foreground">
                    {selectedConversation.name}
                  </h2>
                  <Badge
                    variant="outline"
                    className={cn(
                      "border-0 px-1.5 py-0 text-[10px]",
                      currentChannel.bgColor,
                      currentChannel.color,
                    )}
                  >
                    {currentChannel.name}
                  </Badge>
                </div>
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  {selectedConversation.handle}
                  {selectedConversation.status === "online" ? (
                    <span className="flex items-center gap-1 text-accent">
                      <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                      Online
                    </span>
                  ) : null}
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
                    <Star
                      className={cn(
                        "h-4 w-4",
                        selectedConversation.starred && "fill-primary text-primary",
                      )}
                    />
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
                    <Users className="mr-2 h-4 w-4" />
                    View Contact
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <Tag className="mr-2 h-4 w-4" />
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

          <ScrollArea className="flex-1 p-6">
            <div className="mx-auto max-w-3xl space-y-4">
              <div className="flex items-center gap-4 py-2">
                <div className="h-px flex-1 bg-border" />
                <span className="text-xs text-muted-foreground">Today</span>
                <div className="h-px flex-1 bg-border" />
              </div>

              {messages.map((message) => (
                <motion.div
                  key={message.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={cn(
                    "flex",
                    message.sender === "customer"
                      ? "justify-start"
                      : "justify-end",
                  )}
                >
                  <div
                    className={cn(
                      "group relative max-w-[70%] rounded-lg p-3",
                      message.sender === "customer"
                        ? "bg-secondary text-foreground"
                        : message.isBot
                          ? "border border-primary/20 bg-primary/10 text-foreground"
                          : "bg-primary/20 text-foreground",
                    )}
                  >
                    {message.isBot ? (
                      <div className="mb-1.5 flex items-center gap-1 text-xs text-primary">
                        <Bot className="h-3 w-3" />
                        <span className="font-medium">AI Agent</span>
                      </div>
                    ) : null}
                    <p className="text-sm leading-relaxed">{message.text}</p>
                    <div className="mt-1.5 flex items-center justify-end gap-1.5">
                      <span className="text-[10px] text-muted-foreground">
                        {message.time}
                      </span>
                      {message.sender !== "customer" ? (
                        message.status === "read" ? (
                          <CheckCheck className="h-3 w-3 text-accent" />
                        ) : (
                          <Check className="h-3 w-3 text-muted-foreground" />
                        )
                      ) : null}
                    </div>

                    <div className="absolute -top-2 right-2 opacity-0 transition-opacity group-hover:opacity-100">
                      <div className="flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5 shadow-lg">
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

          <div className="border-t border-border bg-card p-4">
            <div className="mx-auto max-w-3xl">
              <div className="mb-3 flex items-center gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="h-7 gap-1.5 border-border text-xs">
                      <Bot className="h-3 w-3 text-primary" />
                      AI Agent Active
                      <ChevronDown className="h-3 w-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem>
                      <Bot className="mr-2 h-4 w-4 text-primary" />
                      AI Agent Active
                    </DropdownMenuItem>
                    <DropdownMenuItem>
                      <Users className="mr-2 h-4 w-4" />
                      Manual Mode
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs text-muted-foreground">
                  <Clock className="h-3 w-3" />
                  Schedule
                </Button>
                <div className="flex-1" />
                <Badge
                  variant="outline"
                  className={cn(
                    "h-5 border-0 text-[10px]",
                    currentChannel.bgColor,
                    currentChannel.color,
                  )}
                >
                  Replying via {currentChannel.name}
                </Badge>
              </div>
              <div className="flex items-center gap-2 rounded-lg bg-secondary p-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <Paperclip className="h-4 w-4" />
                </Button>
                <Input
                  placeholder={`Message ${selectedConversation.name}...`}
                  value={messageInput}
                  onChange={(event) => setMessageInput(event.target.value)}
                  className="flex-1 border-0 bg-transparent focus:ring-0"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <Smile className="h-4 w-4" />
                </Button>
                <Button size="icon" className="h-9 w-9 shrink-0 bg-primary text-primary-foreground hover:bg-primary/90">
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
