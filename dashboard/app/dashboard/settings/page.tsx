"use client"

import { useState } from "react"
import { motion } from "framer-motion"
import { 
  User,
  Building,
  CreditCard,
  Bell,
  Shield,
  Key,
  Smartphone,
  Globe,
  Mail,
  Phone,
  Save,
  Camera,
  Check,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

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

export default function SettingsPage() {
  const [notifications, setNotifications] = useState({
    email: true,
    push: true,
    sms: false,
    campaignAlerts: true,
    weeklyReport: true,
  })

  return (
    <div className="min-h-screen p-6 lg:p-8">
      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="max-w-[1000px] mx-auto space-y-6"
      >
        {/* Header */}
        <motion.div variants={item}>
          <h1 className="text-3xl font-semibold text-foreground tracking-tight">Settings</h1>
          <p className="text-muted-foreground mt-1">
            Manage your account settings and preferences.
          </p>
        </motion.div>

        {/* Tabs */}
        <motion.div variants={item}>
          <Tabs defaultValue="profile" className="space-y-6">
            <TabsList className="bg-secondary">
              <TabsTrigger value="profile" className="gap-2">
                <User className="h-4 w-4" />
                Profile
              </TabsTrigger>
              <TabsTrigger value="business" className="gap-2">
                <Building className="h-4 w-4" />
                Business
              </TabsTrigger>
              <TabsTrigger value="notifications" className="gap-2">
                <Bell className="h-4 w-4" />
                Notifications
              </TabsTrigger>
              <TabsTrigger value="security" className="gap-2">
                <Shield className="h-4 w-4" />
                Security
              </TabsTrigger>
              <TabsTrigger value="billing" className="gap-2">
                <CreditCard className="h-4 w-4" />
                Billing
              </TabsTrigger>
            </TabsList>

            {/* Profile Tab */}
            <TabsContent value="profile" className="space-y-6">
              <Card className="bg-card border-border">
                <CardHeader>
                  <CardTitle>Profile Information</CardTitle>
                  <CardDescription>Update your personal details and profile picture.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* Avatar */}
                  <div className="flex items-center gap-6">
                    <Avatar className="h-20 w-20 border-2 border-border">
                      <AvatarImage src="/avatars/admin.jpg" />
                      <AvatarFallback className="bg-primary/20 text-primary text-xl">AD</AvatarFallback>
                    </Avatar>
                    <div>
                      <Button variant="outline" className="gap-2 border-border mb-2">
                        <Camera className="h-4 w-4" />
                        Change Photo
                      </Button>
                      <p className="text-xs text-muted-foreground">JPG, PNG or GIF. Max 2MB.</p>
                    </div>
                  </div>

                  {/* Form */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>First Name</Label>
                      <Input defaultValue="Admin" className="bg-secondary border-border" />
                    </div>
                    <div className="space-y-2">
                      <Label>Last Name</Label>
                      <Input defaultValue="User" className="bg-secondary border-border" />
                    </div>
                    <div className="space-y-2">
                      <Label>Email</Label>
                      <Input defaultValue="admin@kasitek.com" className="bg-secondary border-border" />
                    </div>
                    <div className="space-y-2">
                      <Label>Phone</Label>
                      <Input defaultValue="+1 (555) 123-4567" className="bg-secondary border-border" />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>Timezone</Label>
                    <Select defaultValue="utc-5">
                      <SelectTrigger className="bg-secondary border-border max-w-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="utc-8">Pacific Time (UTC-8)</SelectItem>
                        <SelectItem value="utc-5">Eastern Time (UTC-5)</SelectItem>
                        <SelectItem value="utc+0">UTC</SelectItem>
                        <SelectItem value="utc+1">Central European Time (UTC+1)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <Button className="bg-primary text-primary-foreground gap-2">
                    <Save className="h-4 w-4" />
                    Save Changes
                  </Button>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Business Tab */}
            <TabsContent value="business" className="space-y-6">
              <Card className="bg-card border-border">
                <CardHeader>
                  <CardTitle>Business Details</CardTitle>
                  <CardDescription>Manage your business information for WhatsApp Business.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Business Name</Label>
                      <Input defaultValue="KasiTek" className="bg-secondary border-border" />
                    </div>
                    <div className="space-y-2">
                      <Label>Industry</Label>
                      <Select defaultValue="tech">
                        <SelectTrigger className="bg-secondary border-border">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="tech">Technology</SelectItem>
                          <SelectItem value="retail">Retail</SelectItem>
                          <SelectItem value="healthcare">Healthcare</SelectItem>
                          <SelectItem value="finance">Finance</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2 sm:col-span-2">
                      <Label>Business Address</Label>
                      <Input defaultValue="123 Business Street, Suite 100" className="bg-secondary border-border" />
                    </div>
                    <div className="space-y-2">
                      <Label>Website</Label>
                      <Input defaultValue="https://kasitek.com" className="bg-secondary border-border" />
                    </div>
                    <div className="space-y-2">
                      <Label>Support Email</Label>
                      <Input defaultValue="support@kasitek.com" className="bg-secondary border-border" />
                    </div>
                  </div>

                  <Button className="bg-primary text-primary-foreground gap-2">
                    <Save className="h-4 w-4" />
                    Save Changes
                  </Button>
                </CardContent>
              </Card>

              {/* Connected Numbers */}
              <Card className="bg-card border-border">
                <CardHeader>
                  <CardTitle>Connected WhatsApp Numbers</CardTitle>
                  <CardDescription>Manage your verified WhatsApp Business numbers.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {[
                    { number: "+1 (555) 123-4567", status: "verified", default: true },
                    { number: "+1 (555) 987-6543", status: "verified", default: false },
                    { number: "+1 (555) 456-7890", status: "pending", default: false },
                  ].map((phone, index) => (
                    <div key={index} className="flex items-center justify-between p-4 rounded-lg bg-secondary/50 border border-border">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-md bg-primary/10">
                          <Phone className="h-4 w-4 text-primary" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-foreground">{phone.number}</p>
                          <div className="flex items-center gap-2 mt-1">
                            <Badge 
                              variant="outline" 
                              className={
                                phone.status === "verified"
                                  ? "border-accent/30 text-accent bg-accent/10"
                                  : "border-primary/30 text-primary bg-primary/10"
                              }
                            >
                              {phone.status}
                            </Badge>
                            {phone.default && (
                              <Badge variant="outline" className="border-border text-muted-foreground">
                                Default
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                      <Button variant="ghost" size="sm" className="text-muted-foreground">
                        Manage
                      </Button>
                    </div>
                  ))}
                  <Button variant="outline" className="gap-2 border-border">
                    <Smartphone className="h-4 w-4" />
                    Add Number
                  </Button>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Notifications Tab */}
            <TabsContent value="notifications" className="space-y-6">
              <Card className="bg-card border-border">
                <CardHeader>
                  <CardTitle>Notification Preferences</CardTitle>
                  <CardDescription>Choose how you want to receive notifications.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-4">
                    <div className="flex items-center justify-between p-4 rounded-lg bg-secondary/50 border border-border">
                      <div className="flex items-center gap-3">
                        <Mail className="h-5 w-5 text-muted-foreground" />
                        <div>
                          <p className="text-sm font-medium text-foreground">Email Notifications</p>
                          <p className="text-xs text-muted-foreground">Receive updates via email</p>
                        </div>
                      </div>
                      <Switch 
                        checked={notifications.email} 
                        onCheckedChange={(checked) => setNotifications(prev => ({ ...prev, email: checked }))}
                      />
                    </div>

                    <div className="flex items-center justify-between p-4 rounded-lg bg-secondary/50 border border-border">
                      <div className="flex items-center gap-3">
                        <Bell className="h-5 w-5 text-muted-foreground" />
                        <div>
                          <p className="text-sm font-medium text-foreground">Push Notifications</p>
                          <p className="text-xs text-muted-foreground">Browser and mobile push alerts</p>
                        </div>
                      </div>
                      <Switch 
                        checked={notifications.push} 
                        onCheckedChange={(checked) => setNotifications(prev => ({ ...prev, push: checked }))}
                      />
                    </div>

                    <div className="flex items-center justify-between p-4 rounded-lg bg-secondary/50 border border-border">
                      <div className="flex items-center gap-3">
                        <Phone className="h-5 w-5 text-muted-foreground" />
                        <div>
                          <p className="text-sm font-medium text-foreground">SMS Notifications</p>
                          <p className="text-xs text-muted-foreground">Critical alerts via SMS</p>
                        </div>
                      </div>
                      <Switch 
                        checked={notifications.sms} 
                        onCheckedChange={(checked) => setNotifications(prev => ({ ...prev, sms: checked }))}
                      />
                    </div>
                  </div>

                  <div className="border-t border-border pt-6">
                    <h4 className="text-sm font-medium text-foreground mb-4">Alert Types</h4>
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm text-foreground">Campaign Alerts</p>
                          <p className="text-xs text-muted-foreground">Get notified about campaign status changes</p>
                        </div>
                        <Switch 
                          checked={notifications.campaignAlerts} 
                          onCheckedChange={(checked) => setNotifications(prev => ({ ...prev, campaignAlerts: checked }))}
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm text-foreground">Weekly Report</p>
                          <p className="text-xs text-muted-foreground">Receive a weekly performance summary</p>
                        </div>
                        <Switch 
                          checked={notifications.weeklyReport} 
                          onCheckedChange={(checked) => setNotifications(prev => ({ ...prev, weeklyReport: checked }))}
                        />
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Security Tab */}
            <TabsContent value="security" className="space-y-6">
              <Card className="bg-card border-border">
                <CardHeader>
                  <CardTitle>Security Settings</CardTitle>
                  <CardDescription>Manage your account security and authentication.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-2">
                    <Label>Current Password</Label>
                    <Input type="password" className="bg-secondary border-border max-w-md" />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl">
                    <div className="space-y-2">
                      <Label>New Password</Label>
                      <Input type="password" className="bg-secondary border-border" />
                    </div>
                    <div className="space-y-2">
                      <Label>Confirm Password</Label>
                      <Input type="password" className="bg-secondary border-border" />
                    </div>
                  </div>
                  <Button className="bg-primary text-primary-foreground gap-2">
                    Update Password
                  </Button>
                </CardContent>
              </Card>

              <Card className="bg-card border-border">
                <CardHeader>
                  <CardTitle>Two-Factor Authentication</CardTitle>
                  <CardDescription>Add an extra layer of security to your account.</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between p-4 rounded-lg bg-secondary/50 border border-border">
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-md bg-accent/10">
                        <Shield className="h-5 w-5 text-accent" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-foreground">2FA Enabled</p>
                        <p className="text-xs text-muted-foreground">Your account is protected with 2FA</p>
                      </div>
                    </div>
                    <Badge variant="outline" className="border-accent/30 text-accent bg-accent/10">
                      <Check className="h-3 w-3 mr-1" />
                      Active
                    </Badge>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-card border-border">
                <CardHeader>
                  <CardTitle>API Keys</CardTitle>
                  <CardDescription>Manage API keys for external integrations.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between p-4 rounded-lg bg-secondary/50 border border-border">
                    <div className="flex items-center gap-3">
                      <Key className="h-5 w-5 text-muted-foreground" />
                      <div>
                        <p className="text-sm font-medium text-foreground">Production Key</p>
                        <p className="text-xs text-muted-foreground font-mono">sk_live_****...****4f2d</p>
                      </div>
                    </div>
                    <Button variant="outline" size="sm" className="border-border">
                      Regenerate
                    </Button>
                  </div>
                  <Button variant="outline" className="gap-2 border-border">
                    <Key className="h-4 w-4" />
                    Create New Key
                  </Button>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Billing Tab */}
            <TabsContent value="billing" className="space-y-6">
              <Card className="bg-card border-border">
                <CardHeader>
                  <CardTitle>Current Plan</CardTitle>
                  <CardDescription>Manage your subscription and billing.</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="p-6 rounded-lg bg-gradient-to-br from-primary/10 to-primary/5 border border-primary/20">
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <Badge className="bg-primary text-primary-foreground mb-2">Pro Plan</Badge>
                        <h3 className="text-2xl font-semibold text-foreground">$99/month</h3>
                        <p className="text-sm text-muted-foreground">Billed monthly · Renews Feb 15, 2024</p>
                      </div>
                      <Button variant="outline" className="border-border">
                        Change Plan
                      </Button>
                    </div>
                    <div className="grid grid-cols-3 gap-4 pt-4 border-t border-border">
                      <div>
                        <p className="text-2xl font-semibold text-foreground">10,000</p>
                        <p className="text-xs text-muted-foreground">Messages/month</p>
                      </div>
                      <div>
                        <p className="text-2xl font-semibold text-foreground">5</p>
                        <p className="text-xs text-muted-foreground">Phone Numbers</p>
                      </div>
                      <div>
                        <p className="text-2xl font-semibold text-foreground">Unlimited</p>
                        <p className="text-xs text-muted-foreground">Team Members</p>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-card border-border">
                <CardHeader>
                  <CardTitle>Payment Method</CardTitle>
                  <CardDescription>Manage your payment information.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between p-4 rounded-lg bg-secondary/50 border border-border">
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-md bg-secondary">
                        <CreditCard className="h-5 w-5 text-foreground" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-foreground">Visa ending in 4242</p>
                        <p className="text-xs text-muted-foreground">Expires 12/2025</p>
                      </div>
                    </div>
                    <Badge variant="outline" className="border-accent/30 text-accent bg-accent/10">Default</Badge>
                  </div>
                  <Button variant="outline" className="gap-2 border-border">
                    <CreditCard className="h-4 w-4" />
                    Add Payment Method
                  </Button>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </motion.div>
      </motion.div>
    </div>
  )
}
