import { useEffect } from "react"
import { useNavigate } from "react-router"
import { Bell, Cable, CalendarDays, ChartColumn, Code2, FileText, LayoutGrid, Moon, PhoneCall, Send, Settings, Sparkles, Sun, Users } from "lucide-react"

import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from "@/components/ui/command"
import { applyTheme, resolveStoredTheme, serverThemeSnapshot, subscribeToThemeChange } from "@/lib/theme"
import { useSyncExternalStore } from "react"

type CommandPaletteProps = { open: boolean; onOpenChange: (open: boolean) => void }

const routes = [
  { group: "Workspace", label: "Overview", href: "/workspace", icon: LayoutGrid },
  { group: "Workspace", label: "Agents", href: "/agents", icon: Sparkles },
  { group: "Customer", label: "Inbox", href: "/inbox", icon: Bell },
  { group: "Customer", label: "Calls", href: "/calls", icon: PhoneCall },
  { group: "Customer", label: "Contacts", href: "/contacts", icon: Users },
  { group: "Content", label: "Posts", href: "/content", icon: Sparkles },
  { group: "Content", label: "Calendar", href: "/calendar", icon: CalendarDays },
  { group: "Content", label: "Analytics", href: "/content/analytics", icon: ChartColumn },
  { group: "Campaigns", label: "Campaigns", href: "/campaigns", icon: Send },
  { group: "Campaigns", label: "Templates", href: "/templates", icon: FileText },
  { group: "Manage", label: "Developers", href: "/developers", icon: Code2 },
  { group: "Manage", label: "Connections", href: "/connections", icon: Cable },
  { group: "Manage", label: "Workspace settings", href: "/workspace/settings", icon: Settings },
] as const

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate()
  const theme = useSyncExternalStore(subscribeToThemeChange, resolveStoredTheme, serverThemeSnapshot)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        onOpenChange(!open)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onOpenChange, open])

  const go = (href: string) => {
    onOpenChange(false)
    navigate(href)
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} showCloseButton={false}>
      <CommandInput placeholder="Search pages and actions…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        {Array.from(new Set(routes.map((route) => route.group))).map((group, index) => (
          <div key={group}>
            {index > 0 ? <CommandSeparator /> : null}
            <CommandGroup heading={group}>
              {routes.filter((route) => route.group === group).map((route) => {
                const Icon = route.icon
                return <CommandItem key={route.href} value={`${route.group} ${route.label}`} onSelect={() => go(route.href)}><Icon />{route.label}</CommandItem>
              })}
            </CommandGroup>
          </div>
        ))}
        <CommandSeparator />
        <CommandGroup heading="Actions">
          <CommandItem onSelect={() => applyTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? <Sun /> : <Moon />} Toggle theme<CommandShortcut>⇧T</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
