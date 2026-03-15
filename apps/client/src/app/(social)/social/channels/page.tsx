"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const channels = [
  { name: "Facebook", status: "Connected", helper: "Primary community and offer updates" },
  { name: "Instagram", status: "Connected", helper: "Visual content and reels planning" },
  { name: "LinkedIn", status: "Needs setup", helper: "B2B authority and founder content" },
  { name: "X", status: "Connected", helper: "Fast-moving updates, promos, and commentary" },
  { name: "WhatsApp Status", status: "Coming soon", helper: "Short-form status publishing and reminders" },
];

export default function SocialChannelsPage() {
  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1400px] space-y-6">
        <div>
          <Badge className="mb-2 border-primary/30 bg-primary/5 text-primary">Channels</Badge>
          <h1 className="text-3xl font-semibold tracking-tight">Connect and manage publishing destinations.</h1>
          <p className="mt-1 text-muted-foreground">
            Own account auth, page selection, permissions, and per-channel formatting from here.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Channel Connections</CardTitle>
            <CardDescription>Suggested control center for connected destinations.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {channels.map((channel) => (
              <div key={channel.name} className="flex items-center justify-between rounded-md bg-secondary/50 p-4">
                <div>
                  <div className="text-sm font-semibold">{channel.name}</div>
                  <div className="text-sm text-muted-foreground">{channel.helper}</div>
                </div>
                <Badge
                  className={
                    channel.status === "Connected"
                      ? "border-accent/30 bg-accent/10 text-accent"
                      : channel.status === "Needs setup"
                        ? "border-primary/30 bg-primary/10 text-primary"
                        : "border-border bg-background text-muted-foreground"
                  }
                >
                  {channel.status}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
