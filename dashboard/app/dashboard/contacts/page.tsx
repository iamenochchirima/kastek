"use client"

import { useState } from "react"
import { motion } from "framer-motion"
import { 
  Search, 
  Filter, 
  MoreVertical, 
  Plus,
  Download,
  Upload,
  Mail,
  Phone,
  Tag,
  Calendar,
  CheckCircle,
  XCircle,
  User,
  Users,
  UserX,
  MessageSquare,
  ChevronDown,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

const container = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.03 }
  }
}

const item = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: "easeOut" } }
}

const contacts = [
  {
    id: 1,
    name: "Sarah Johnson",
    email: "sarah.johnson@email.com",
    phone: "+1 (555) 123-4567",
    status: "opted-in",
    tags: ["VIP", "Customer"],
    campaigns: 5,
    lastContacted: "2 hours ago",
    createdAt: "Jan 15, 2024",
  },
  {
    id: 2,
    name: "Michael Chen",
    email: "m.chen@company.com",
    phone: "+1 (555) 234-5678",
    status: "opted-in",
    tags: ["Lead", "Hot"],
    campaigns: 3,
    lastContacted: "1 day ago",
    createdAt: "Jan 20, 2024",
  },
  {
    id: 3,
    name: "Emily Davis",
    email: "emily.d@business.org",
    phone: "+1 (555) 345-6789",
    status: "excluded",
    tags: ["Customer"],
    campaigns: 8,
    lastContacted: "1 week ago",
    createdAt: "Dec 10, 2023",
  },
  {
    id: 4,
    name: "James Wilson",
    email: "jwilson@corp.net",
    phone: "+1 (555) 456-7890",
    status: "opted-in",
    tags: ["Prospect"],
    campaigns: 2,
    lastContacted: "3 days ago",
    createdAt: "Feb 1, 2024",
  },
  {
    id: 5,
    name: "Lisa Anderson",
    email: "lisa.a@email.com",
    phone: "+1 (555) 567-8901",
    status: "opted-in",
    tags: ["Customer", "Enterprise"],
    campaigns: 12,
    lastContacted: "5 hours ago",
    createdAt: "Nov 5, 2023",
  },
  {
    id: 6,
    name: "Robert Brown",
    email: "r.brown@startup.io",
    phone: "+1 (555) 678-9012",
    status: "excluded",
    tags: ["Unsubscribed"],
    campaigns: 1,
    lastContacted: "2 weeks ago",
    createdAt: "Jan 28, 2024",
  },
]

const stats = [
  { label: "Total Contacts", value: "3,003", icon: Users, change: "+89 this week" },
  { label: "Opted In", value: "2,847", icon: CheckCircle, change: "94.8%" },
  { label: "Excluded", value: "156", icon: UserX, change: "5.2%" },
  { label: "Campaigns Sent", value: "8,429", icon: MessageSquare, change: "Avg 2.8/contact" },
]

export default function ContactsPage() {
  const [selectedContacts, setSelectedContacts] = useState<number[]>([])
  const [searchQuery, setSearchQuery] = useState("")

  const toggleContact = (id: number) => {
    setSelectedContacts(prev => 
      prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]
    )
  }

  const toggleAll = () => {
    if (selectedContacts.length === contacts.length) {
      setSelectedContacts([])
    } else {
      setSelectedContacts(contacts.map(c => c.id))
    }
  }

  const filteredContacts = contacts.filter(contact => 
    contact.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    contact.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
    contact.phone.includes(searchQuery)
  )

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
            <h1 className="text-3xl font-semibold text-foreground tracking-tight">Contacts</h1>
            <p className="text-muted-foreground mt-1">
              Manage your contact database and audience segments.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" className="gap-2 border-border">
              <Upload className="h-4 w-4" />
              Import
            </Button>
            <Button variant="outline" className="gap-2 border-border">
              <Download className="h-4 w-4" />
              Export
            </Button>
            <Button className="bg-primary text-primary-foreground hover:bg-primary/90 gap-2">
              <Plus className="h-4 w-4" />
              Add Contact
            </Button>
          </div>
        </motion.div>

        {/* Stats */}
        <motion.div variants={item} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {stats.map((stat, index) => (
            <Card key={index} className="bg-card border-border">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-wider text-muted-foreground">{stat.label}</p>
                    <p className="text-2xl font-semibold text-foreground mt-1">{stat.value}</p>
                    <p className="text-xs text-accent mt-1">{stat.change}</p>
                  </div>
                  <div className="p-2 rounded-md bg-primary/10">
                    <stat.icon className="h-5 w-5 text-primary" />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </motion.div>

        {/* Search and Filters */}
        <motion.div variants={item} className="flex flex-col sm:flex-row gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input 
              placeholder="Search contacts by name, email, or phone..." 
              className="pl-9 bg-card border-border"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="gap-2 border-border">
                  <Filter className="h-4 w-4" />
                  Status
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem>All Contacts</DropdownMenuItem>
                <DropdownMenuItem>Opted In</DropdownMenuItem>
                <DropdownMenuItem>Excluded</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="gap-2 border-border">
                  <Tag className="h-4 w-4" />
                  Tags
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem>VIP</DropdownMenuItem>
                <DropdownMenuItem>Customer</DropdownMenuItem>
                <DropdownMenuItem>Lead</DropdownMenuItem>
                <DropdownMenuItem>Prospect</DropdownMenuItem>
                <DropdownMenuItem>Enterprise</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </motion.div>

        {/* Bulk Actions */}
        {selectedContacts.length > 0 && (
          <motion.div 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-4 p-3 rounded-lg bg-primary/10 border border-primary/20"
          >
            <span className="text-sm text-foreground">
              {selectedContacts.length} contact{selectedContacts.length > 1 ? 's' : ''} selected
            </span>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" className="gap-1 border-border">
                <MessageSquare className="h-3 w-3" />
                Send Message
              </Button>
              <Button size="sm" variant="outline" className="gap-1 border-border">
                <Tag className="h-3 w-3" />
                Add Tag
              </Button>
              <Button size="sm" variant="outline" className="gap-1 border-border text-destructive hover:text-destructive">
                <XCircle className="h-3 w-3" />
                Exclude
              </Button>
            </div>
          </motion.div>
        )}

        {/* Contacts Table */}
        <motion.div variants={item}>
          <Card className="bg-card border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="w-12">
                    <Checkbox 
                      checked={selectedContacts.length === contacts.length}
                      onCheckedChange={toggleAll}
                    />
                  </TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead>Campaigns</TableHead>
                  <TableHead>Last Contacted</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredContacts.map((contact) => (
                  <TableRow 
                    key={contact.id} 
                    className="border-border hover:bg-secondary/50 transition-colors"
                  >
                    <TableCell>
                      <Checkbox 
                        checked={selectedContacts.includes(contact.id)}
                        onCheckedChange={() => toggleContact(contact.id)}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar className="h-9 w-9 bg-secondary">
                          <AvatarFallback className="bg-secondary text-foreground text-xs">
                            {contact.name.split(' ').map(n => n[0]).join('')}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <p className="text-sm font-medium text-foreground">{contact.name}</p>
                          <p className="text-xs text-muted-foreground flex items-center gap-1">
                            <Mail className="h-3 w-3" />
                            {contact.email}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-muted-foreground">{contact.phone}</span>
                    </TableCell>
                    <TableCell>
                      <Badge 
                        variant="outline" 
                        className={
                          contact.status === "opted-in"
                            ? "border-accent/30 text-accent bg-accent/10"
                            : "border-destructive/30 text-destructive bg-destructive/10"
                        }
                      >
                        {contact.status === "opted-in" ? (
                          <CheckCircle className="h-3 w-3 mr-1" />
                        ) : (
                          <XCircle className="h-3 w-3 mr-1" />
                        )}
                        {contact.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {contact.tags.map((tag) => (
                          <Badge 
                            key={tag} 
                            variant="outline" 
                            className="text-xs border-border text-muted-foreground"
                          >
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-foreground">{contact.campaigns}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-muted-foreground">{contact.lastContacted}</span>
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground">
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem>
                            <User className="mr-2 h-4 w-4" />
                            View Profile
                          </DropdownMenuItem>
                          <DropdownMenuItem>
                            <MessageSquare className="mr-2 h-4 w-4" />
                            Send Message
                          </DropdownMenuItem>
                          <DropdownMenuItem>
                            <Tag className="mr-2 h-4 w-4" />
                            Edit Tags
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-destructive">
                            <XCircle className="mr-2 h-4 w-4" />
                            Exclude
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </motion.div>
      </motion.div>
    </div>
  )
}
