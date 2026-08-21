"use client";

import { apiUrl } from "@/lib/server-api";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/ui/page-header";
import { ContentWorkspaceNavigation } from "@/components/social/content-workspace-navigation";
import { type SocialPost, formatDateTime, getPlatformLabel, getPostStatusMeta } from "@/components/social/social-shared";

const week = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function CalendarView() {
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [currentMonth, setCurrentMonth] = useState(() => {
    const date = new Date();
    return new Date(date.getFullYear(), date.getMonth(), 1);
  });

  useEffect(() => {
    void loadPosts();
  }, []);

  async function loadPosts() {
    setLoading(true);
    setError("");

    try {
      const response = await fetch(apiUrl("/api/social/posts"), {
        cache: "no-store",
        credentials: "include",
      });
      const payload = (await response.json()) as { posts?: SocialPost[]; error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Failed to load calendar posts");
      }

      setPosts(payload.posts || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load calendar posts");
    } finally {
      setLoading(false);
    }
  }

  const calendarDays = useMemo(() => {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const leadingDays = (firstDay.getDay() + 6) % 7;
    const trailingDays = 6 - ((lastDay.getDay() + 6) % 7);

    const days: { date: Date; inMonth: boolean }[] = [];

    for (let index = leadingDays; index > 0; index -= 1) {
      days.push({ date: new Date(year, month, 1 - index), inMonth: false });
    }

    for (let day = 1; day <= lastDay.getDate(); day += 1) {
      days.push({ date: new Date(year, month, day), inMonth: true });
    }

    for (let day = 1; day <= trailingDays; day += 1) {
      days.push({ date: new Date(year, month + 1, day), inMonth: false });
    }

    return days;
  }, [currentMonth]);

  const scheduledPosts = posts.filter((post) => post.scheduledFor);
  const draftPosts = posts.filter((post) => !post.scheduledFor);

  function getPostsForDate(date: Date) {
    return scheduledPosts.filter((post) => {
      const scheduledDate = new Date(post.scheduledFor as string);
      return (
        scheduledDate.getFullYear() === date.getFullYear() &&
        scheduledDate.getMonth() === date.getMonth() &&
        scheduledDate.getDate() === date.getDate()
      );
    });
  }

  return (
    <div className="min-h-screen p-4 sm:p-6">
      <div className="mx-auto max-w-[1440px] space-y-6">
        <PageHeader>
          <PageHeaderContent>
            <PageHeaderTitle>Calendar</PageHeaderTitle>
            <PageHeaderDescription>Scheduled posts.</PageHeaderDescription>
          </PageHeaderContent>
          <PageHeaderActions className="w-full justify-between sm:w-auto sm:justify-start">
            <Button
              variant="outline"
              size="icon"
              onClick={() =>
                setCurrentMonth((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1))
              }
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="text-center text-sm font-medium text-foreground">
              {currentMonth.toLocaleDateString("en-ZA", { month: "long", year: "numeric" })}
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={() =>
                setCurrentMonth((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1))
              }
            >
              <ArrowRight className="h-4 w-4" />
            </Button>
          </PageHeaderActions>
        </PageHeader>

        <ContentWorkspaceNavigation active="calendar" />

        {error ? (
          <div className="rounded-md border border-destructive/30 bg-status-danger-soft px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_360px]">
          <Card>
            <CardHeader>
              <CardTitle>Monthly Publishing Calendar</CardTitle>
              <CardDescription>Scheduled posts are rendered by their saved publish date.</CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <>
                  <div className="space-y-3 md:hidden">
                    {Array.from({ length: 5 }).map((_, index) => (
                      <div key={index} className="rounded-xl border border-border/70 bg-secondary/20 p-4">
                        <div className="flex items-center justify-between">
                          <Skeleton className="h-4 w-28" />
                          <Skeleton className="h-5 w-8 rounded-full" />
                        </div>
                        <div className="mt-3 space-y-2">
                          <Skeleton className="h-12 w-full rounded-lg" />
                          <Skeleton className="h-10 w-full rounded-lg" />
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="hidden gap-3 md:grid md:grid-cols-7">
                    {week.map((day) => (
                      <div key={day} className="hidden text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground md:block">
                        {day}
                      </div>
                    ))}
                    {Array.from({ length: 35 }).map((_, index) => (
                      <div key={index} className="min-h-[170px] rounded-xl border border-border/60 p-3">
                        <Skeleton className="h-4 w-8" />
                        <div className="mt-3 space-y-2">
                          <Skeleton className="h-12 w-full rounded-md" />
                          <Skeleton className="h-10 w-full rounded-md" />
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <>
                <div className="space-y-3 md:hidden">
                  {calendarDays
                    .filter(({ inMonth }) => inMonth)
                    .map(({ date }) => {
                      const items = getPostsForDate(date);
                      return (
                        <div key={date.toISOString()} className="rounded-xl border border-border/70 bg-secondary/20 p-4">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-semibold text-foreground">
                              {date.toLocaleDateString("en-ZA", {
                                weekday: "short",
                                day: "numeric",
                                month: "short",
                              })}
                            </span>
                            {items.length ? (
                              <Badge className="border-primary/30 bg-primary/10 text-primary">
                                {items.length}
                              </Badge>
                            ) : null}
                          </div>
                          <div className="mt-3 space-y-2">
                            {items.length === 0 ? (
                              <div className="rounded-md border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
                                Open slot
                              </div>
                            ) : (
                              items.map((post) => {
                                const status = getPostStatusMeta(post.status);
                                return (
                                  <div key={post.id} className="rounded-lg border border-border/60 bg-background/40 px-3 py-2">
                                    <p className="text-xs font-medium text-foreground">
                                      {post.title || "Untitled post"}
                                    </p>
                                    <p className="mt-1 text-[11px] text-muted-foreground">
                                      {post.channels.map(getPlatformLabel).join(", ")}
                                    </p>
                                    <Badge className={`mt-2 ${status.className}`}>{status.label}</Badge>
                                  </div>
                                );
                              })
                            )}
                          </div>
                        </div>
                      );
                    })}
                </div>

                <div className="hidden gap-3 md:grid md:grid-cols-7">
                  {week.map((day) => (
                    <div key={day} className="hidden text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground md:block">
                      {day}
                    </div>
                  ))}
                  {calendarDays.map(({ date, inMonth }) => {
                    const items = getPostsForDate(date);
                    return (
                      <div
                        key={date.toISOString()}
                        className={`min-h-[170px] rounded-xl border p-3 ${
                          inMonth ? "border-border/70 bg-secondary/30" : "border-border/40 bg-secondary/10"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className={`text-sm font-semibold ${inMonth ? "text-foreground" : "text-muted-foreground"}`}>
                            {date.getDate()}
                          </span>
                          {items.length ? (
                            <Badge className="border-primary/30 bg-primary/10 text-primary">
                              {items.length}
                            </Badge>
                          ) : null}
                        </div>
                        <div className="mt-3 space-y-2">
                          {items.length === 0 ? (
                            <div className="rounded-md border border-dashed border-border/60 px-3 py-4 text-xs text-muted-foreground">
                              Open slot
                            </div>
                          ) : (
                            items.slice(0, 3).map((post) => {
                              const status = getPostStatusMeta(post.status);
                              return (
                                <div key={post.id} className="rounded-lg border border-border/60 bg-background/40 px-3 py-2">
                                  <p className="truncate text-xs font-medium text-foreground">
                                    {post.title || "Untitled post"}
                                  </p>
                                  <p className="mt-1 truncate text-[11px] text-muted-foreground">
                                    {post.channels.map(getPlatformLabel).join(", ")}
                                  </p>
                                  <Badge className={`mt-2 ${status.className}`}>{status.label}</Badge>
                                </div>
                              );
                            })
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                </>
              )}
            </CardContent>
          </Card>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Upcoming Schedule</CardTitle>
                <CardDescription>The next few items in the publishing queue.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {scheduledPosts.slice(0, 6).map((post) => (
                  <div key={post.id} className="rounded-xl border border-border/70 bg-secondary/30 p-4">
                    <p className="font-medium text-foreground">{post.title || "Untitled post"}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{formatDateTime(post.scheduledFor)}</p>
                    <p className="mt-2 text-xs uppercase tracking-[0.16em] text-muted-foreground">
                      {post.channels.map(getPlatformLabel).join(" • ")}
                    </p>
                  </div>
                ))}
                {!loading && scheduledPosts.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
                    No scheduled posts yet.
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Draft Bucket</CardTitle>
                <CardDescription>Posts still waiting for a date and time.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {draftPosts.slice(0, 5).map((post) => (
                  <div key={post.id} className="rounded-xl border border-border/70 bg-secondary/30 p-4">
                    <p className="font-medium text-foreground">{post.title || "Untitled draft"}</p>
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{post.content}</p>
                  </div>
                ))}
                {!loading && draftPosts.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
                    No unscheduled drafts.
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
