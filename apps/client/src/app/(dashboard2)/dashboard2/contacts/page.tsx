"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download, Plus, Search, Upload } from "lucide-react";

const contacts = [
  { id: 1, name: "Sarah Johnson", email: "sarah.johnson@email.com", phone: "+1 (555) 123-4567", status: "opted-in", tags: ["VIP", "Customer"], campaigns: 5, lastContacted: "2 hours ago", createdAt: "Jan 15, 2024" },
  { id: 2, name: "Michael Chen", email: "m.chen@company.com", phone: "+1 (555) 234-5678", status: "opted-in", tags: ["Lead", "Hot"], campaigns: 3, lastContacted: "1 day ago", createdAt: "Jan 20, 2024" },
  { id: 3, name: "Emily Davis", email: "emily.d@business.org", phone: "+1 (555) 345-6789", status: "excluded", tags: ["Customer"], campaigns: 8, lastContacted: "1 week ago", createdAt: "Dec 10, 2023" },
];

export default function Dashboard2ContactsPage() {
  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1400px] space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Contacts</h1>
            <p className="mt-1 text-muted-foreground">Manage your contact database and audience segments.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline"><Upload className="h-4 w-4" />Import</Button>
            <Button variant="outline"><Download className="h-4 w-4" />Export</Button>
            <Button><Plus className="h-4 w-4" />Add Contact</Button>
          </div>
        </div>
        <div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input placeholder="Search contacts by name, email, or phone..." className="pl-9" /></div>
        <Card>
          <CardContent className="overflow-x-auto">
            <Table className="min-w-[760px]">
              <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Status</TableHead><TableHead>Tags</TableHead><TableHead>Campaigns</TableHead><TableHead>Last Contacted</TableHead><TableHead>Created</TableHead></TableRow></TableHeader>
              <TableBody>
                {contacts.map((contact) => (
                  <TableRow key={contact.id}>
                    <TableCell><div className="font-medium">{contact.name}</div><div className="text-xs text-muted-foreground">{contact.email}</div><div className="text-xs text-muted-foreground">{contact.phone}</div></TableCell>
                    <TableCell><Badge className={contact.status === "opted-in" ? "border-accent/30 bg-accent/10 text-accent" : "border-destructive/30 bg-destructive/10 text-destructive"}>{contact.status}</Badge></TableCell>
                    <TableCell><div className="flex flex-wrap gap-2">{contact.tags.map((tag) => <Badge key={tag} className="border-border bg-secondary text-muted-foreground">{tag}</Badge>)}</div></TableCell>
                    <TableCell>{contact.campaigns}</TableCell>
                    <TableCell>{contact.lastContacted}</TableCell>
                    <TableCell>{contact.createdAt}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
