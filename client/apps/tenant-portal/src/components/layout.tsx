"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { 
  LayoutDashboard, 
  Users, 
  PenTool, 
  BarChart3, 
  Mail, 
  SearchCheck, 
  Mic, 
  Star, 
  Megaphone,
  LogOut,
  BrainCircuit
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/leads", label: "Leads", icon: Users },
  { href: "/content", label: "Content Pipeline", icon: PenTool },
  { href: "/reporting", label: "Client Reporting", icon: BarChart3 },
  { href: "/nurturing", label: "Nurturing", icon: Mail },
  { href: "/aeo", label: "AEO", icon: SearchCheck },
  { href: "/voice", label: "Voice Agents", icon: Mic },
  { href: "/reviews", label: "Reputation", icon: Star },
  { href: "/adcreative", label: "Ad Creatives", icon: Megaphone },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { logout } = useAuth();

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 border-r border-border bg-sidebar flex flex-col h-full shrink-0">
        <div className="h-16 flex items-center px-6 border-b border-border">
          <BrainCircuit className="w-6 h-6 text-primary mr-3" />
          <span className="font-bold text-lg tracking-tight">AgencyOS</span>
        </div>
        
        <div className="flex-1 overflow-y-auto py-4">
          <nav className="space-y-1 px-3">
            {navItems.map((item) => {
              const isActive =
                pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
              const Icon = item.icon;
              
              return (
                <Link key={item.href} href={item.href}>
                  <div className={`flex items-center px-3 py-2.5 rounded-md cursor-pointer transition-colors ${isActive ? 'bg-primary/10 text-primary font-medium' : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'}`}>
                    <Icon className={`w-5 h-5 mr-3 ${isActive ? 'text-primary' : 'text-muted-foreground'}`} />
                    {item.label}
                  </div>
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="p-4 border-t border-border">
          <Button variant="ghost" className="w-full justify-start text-muted-foreground hover:text-foreground" onClick={logout}>
            <LogOut className="w-5 h-5 mr-3" />
            Logout
          </Button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto bg-background/50 relative">
        {children}
      </main>
    </div>
  );
}
