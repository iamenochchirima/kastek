"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import { motion, AnimatePresence } from "framer-motion"
import {
  LayoutGrid,
  Bot,
  Inbox,
  Users,
  FileText,
  Send,
  Settings,
  Bell,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  LogOut,
  Menu,
  Plus,
  List,
  Clock,
  CheckCircle,
  Archive,
  BarChart3,
  Zap,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet"
import { ThemeToggle } from "@/components/theme-toggle"

type NavItem = {
  name: string
  href: string
  icon: React.ComponentType<{ className?: string }>
  submenu?: { name: string; href: string; icon: React.ComponentType<{ className?: string }> }[]
}

const navigation: NavItem[] = [
  { name: "Overview", href: "/dashboard", icon: LayoutGrid },
  { name: "My Bots", href: "/dashboard/bots", icon: Bot },
  { name: "Inbox", href: "/dashboard/inbox", icon: Inbox },
  { name: "Contacts", href: "/dashboard/contacts", icon: Users },
  { 
    name: "Templates", 
    href: "/dashboard/templates", 
    icon: FileText,
    submenu: [
      { name: "All Templates", href: "/dashboard/templates", icon: List },
      { name: "Create New", href: "/dashboard/templates/create", icon: Plus },
      { name: "Pending Review", href: "/dashboard/templates/pending", icon: Clock },
      { name: "Approved", href: "/dashboard/templates/approved", icon: CheckCircle },
    ]
  },
  { 
    name: "Campaigns", 
    href: "/dashboard/campaigns", 
    icon: Send,
    submenu: [
      { name: "All Campaigns", href: "/dashboard/campaigns", icon: List },
      { name: "Create Campaign", href: "/dashboard/campaigns/create", icon: Plus },
      { name: "Active", href: "/dashboard/campaigns/active", icon: Zap },
      { name: "Archived", href: "/dashboard/campaigns/archived", icon: Archive },
      { name: "Analytics", href: "/dashboard/campaigns/analytics", icon: BarChart3 },
    ]
  },
  { name: "Settings", href: "/dashboard/settings", icon: Settings },
]

function SidebarContent({ collapsed, setCollapsed }: { collapsed: boolean; setCollapsed?: (v: boolean) => void }) {
  const pathname = usePathname()
  const [openSubmenus, setOpenSubmenus] = useState<string[]>([])

  const toggleSubmenu = (name: string) => {
    setOpenSubmenus(prev => 
      prev.includes(name) 
        ? prev.filter(n => n !== name)
        : [...prev, name]
    )
  }

  const isSubmenuOpen = (name: string) => openSubmenus.includes(name)
  const isActiveInSubmenu = (item: NavItem) => 
    item.submenu?.some(sub => pathname === sub.href) || pathname === item.href

  return (
    <div className="flex h-full flex-col bg-card border-r border-border">
      {/* Logo */}
      <div className="flex h-16 items-center justify-between px-4 border-b border-border">
        <Link href="/dashboard" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-sm bg-primary">
            <span className="font-display text-lg text-primary-foreground">K</span>
          </div>
          {!collapsed && (
            <div className="flex flex-col">
              <span className="font-display text-lg tracking-wide text-foreground">KasiTek</span>
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Workspace</span>
            </div>
          )}
        </Link>
        {setCollapsed && !collapsed && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={() => setCollapsed(true)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 p-3 overflow-y-auto">
        {navigation.map((item) => {
          const isActive = pathname === item.href && !item.submenu
          const hasSubmenu = !!item.submenu
          const isOpen = isSubmenuOpen(item.name)
          const isParentActive = isActiveInSubmenu(item)

          if (hasSubmenu) {
            return (
              <div key={item.name}>
                <button
                  onClick={() => toggleSubmenu(item.name)}
                  className={cn(
                    "group flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-all duration-200",
                    isParentActive
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                  )}
                >
                  <item.icon className={cn("h-5 w-5 shrink-0", isParentActive && "text-primary")} />
                  {!collapsed && (
                    <>
                      <span className="flex-1 text-left">{item.name}</span>
                      <ChevronDown 
                        className={cn(
                          "h-4 w-4 transition-transform duration-200",
                          isOpen && "rotate-180"
                        )} 
                      />
                    </>
                  )}
                </button>
                
                <AnimatePresence>
                  {isOpen && !collapsed && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden"
                    >
                      <div className="ml-4 mt-1 space-y-1 border-l border-border pl-3">
                        {item.submenu?.map((subItem) => {
                          const isSubActive = pathname === subItem.href
                          return (
                            <Link
                              key={subItem.href}
                              href={subItem.href}
                              className={cn(
                                "group flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-all duration-200",
                                isSubActive
                                  ? "bg-primary/10 text-primary font-medium"
                                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                              )}
                            >
                              <subItem.icon className={cn("h-4 w-4 shrink-0", isSubActive && "text-primary")} />
                              <span>{subItem.name}</span>
                            </Link>
                          )
                        })}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )
          }

          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                "group flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-all duration-200",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              )}
            >
              <item.icon className={cn("h-5 w-5 shrink-0", isActive && "text-primary")} />
              {!collapsed && <span className="flex-1">{item.name}</span>}
            </Link>
          )
        })}
      </nav>

      {/* Bottom section */}
      <div className="border-t border-border p-3 space-y-1">
        {/* Theme Toggle */}
        <div className={cn(
          "flex items-center gap-3 rounded-md px-3 py-1",
          collapsed ? "justify-center" : ""
        )}>
          <ThemeToggle className="text-muted-foreground hover:text-foreground" />
          {!collapsed && <span className="text-sm text-muted-foreground">Theme</span>}
        </div>

        <Link
          href="/dashboard/notifications"
          className="flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-all duration-200"
        >
          <Bell className="h-5 w-5 shrink-0" />
          {!collapsed && <span>Notifications</span>}
        </Link>

        {/* User profile */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-all duration-200">
              <Avatar className="h-7 w-7 border border-border">
                <AvatarImage src="/avatars/admin.jpg" />
                <AvatarFallback className="bg-primary/20 text-primary text-xs">AD</AvatarFallback>
              </Avatar>
              {!collapsed && (
                <div className="flex-1 text-left">
                  <p className="text-sm font-medium text-foreground">Admin</p>
                  <p className="text-xs text-muted-foreground truncate">admin@kasitek.com</p>
                </div>
              )}
              {!collapsed && <ChevronRight className="h-4 w-4 opacity-50" />}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem>
              <Settings className="mr-2 h-4 w-4" />
              Account Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive">
              <LogOut className="mr-2 h-4 w-4" />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Expand button when collapsed */}
      {setCollapsed && collapsed && (
        <div className="border-t border-border p-3">
          <Button
            variant="ghost"
            size="icon"
            className="w-full h-9 text-muted-foreground hover:text-foreground"
            onClick={() => setCollapsed(false)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  )
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div className="flex h-screen bg-background">
      {/* Desktop Sidebar */}
      <aside
        className={cn(
          "hidden lg:flex flex-col transition-all duration-300 ease-in-out",
          collapsed ? "w-[72px]" : "w-64"
        )}
      >
        <SidebarContent collapsed={collapsed} setCollapsed={setCollapsed} />
      </aside>

      {/* Mobile Sidebar */}
      <Sheet>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="lg:hidden fixed top-4 left-4 z-50">
            <Menu className="h-5 w-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-64 p-0">
          <SidebarContent collapsed={false} />
        </SheetContent>
      </Sheet>

      {/* Main Content */}
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  )
}
