"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const week = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function SocialCalendarPage() {
  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <div>
          <Badge className="mb-2 border-primary/30 bg-primary/5 text-primary">Calendar</Badge>
          <h1 className="text-3xl font-semibold tracking-tight">See the whole publishing rhythm at a glance.</h1>
          <p className="mt-1 text-muted-foreground">
            Use this surface for balancing channels, spotting content gaps, and scheduling WhatsApp Status alongside social posts.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Monthly Publishing Calendar</CardTitle>
            <CardDescription>Prototype layout for scheduled posts and open content slots.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-7">
              {week.map((day, index) => (
                <div key={day} className="rounded-md bg-secondary/50 p-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{day}</div>
                  <div className="mt-4 text-2xl font-semibold">{index + 10}</div>
                  <div className="mt-4 space-y-2">
                    {index % 2 === 0 ? (
                      <>
                        <div className="rounded-md bg-primary/10 px-3 py-2 text-xs text-primary">Launch promo</div>
                        <div className="rounded-md bg-accent/10 px-3 py-2 text-xs text-accent">Status update</div>
                      </>
                    ) : (
                      <div className="rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
                        Open slot
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
