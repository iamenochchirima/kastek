"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const lanes = [
  { title: "Ideas", count: "11", items: ["Sunday promo prompt", "Monthly offer campaign", "Owner story clip"] },
  { title: "Drafting", count: "4", items: ["AI caption for breakfast special", "Recruitment post", "Community spotlight"] },
  { title: "Approved", count: "7", items: ["Weekend teaser", "Menu announcement", "Customer testimonial"] },
];

export default function SocialPlannerPage() {
  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <div>
          <Badge className="mb-2 border-primary/30 bg-primary/5 text-primary">Planner</Badge>
          <h1 className="text-3xl font-semibold tracking-tight">Move ideas into scheduled content.</h1>
          <p className="mt-1 text-muted-foreground">
            This board is where ideation, AI drafting, approvals, and scheduling converge.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          {lanes.map((lane) => (
            <Card key={lane.title}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  <span>{lane.title}</span>
                  <span className="text-sm text-muted-foreground">{lane.count}</span>
                </CardTitle>
                <CardDescription>
                  {lane.title === "Ideas"
                    ? "Raw prompts and themes"
                    : lane.title === "Drafting"
                      ? "Posts being refined"
                      : "Ready to schedule"}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {lane.items.map((item) => (
                  <div key={item} className="rounded-md bg-secondary/50 p-4 text-sm text-foreground">
                    {item}
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
