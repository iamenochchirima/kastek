"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Wand2 } from "lucide-react";

export default function SocialPostsPage() {
  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1400px] space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Badge className="mb-2 border-primary/30 bg-primary/5 text-primary">Posts</Badge>
            <h1 className="text-3xl font-semibold tracking-tight">Create once, adapt everywhere.</h1>
            <p className="mt-1 text-muted-foreground">
              This is the core content production surface for AI drafting, channel variants, and approvals.
            </p>
          </div>
          <Button className="gap-2"><Wand2 className="h-4 w-4" />New AI Draft</Button>
        </div>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_380px]">
          <Card>
            <CardHeader>
              <CardTitle>Draft Queue</CardTitle>
              <CardDescription>Suggested workflow for content production.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-3">
              {[
                { title: "Ideas", count: "11", helper: "Offer prompts and campaign concepts" },
                { title: "Drafting", count: "4", helper: "AI-generated captions awaiting edits" },
                { title: "Approved", count: "7", helper: "Ready to place on the calendar" },
              ].map((column) => (
                <div key={column.title} className="rounded-md bg-secondary/50 p-4">
                  <div className="text-sm font-semibold">{column.title}</div>
                  <div className="mt-3 text-3xl font-semibold">{column.count}</div>
                  <div className="mt-2 text-sm text-muted-foreground">{column.helper}</div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>AI Composer</CardTitle>
              <CardDescription>Prompt and generate on-brand captions.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Input value="Write a warm promo post for a Sunday opening special with a CTA to order early." readOnly />
              <div className="rounded-md bg-primary/10 p-4 text-sm leading-6 text-foreground">
                Fresh croissants, coffee, and a slower Sunday morning. We&apos;re open this Sunday from 8am.
                Pop in early or message us to reserve your order before the rush starts.
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
