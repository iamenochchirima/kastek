"use client";

import { apiUrl } from "@/lib/server-api";
import { useNavigate } from "react-router";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/ui/page-header";
import { ContentWorkspaceNavigation } from "@/components/social/content-workspace-navigation";
import { type SocialPost, formatDateTime, getPlatformLabel, getPostStatusMeta } from "@/components/social/social-shared";
import { useAppearance } from "@/lib/appearance";
import { MotionReveal } from "@/components/ui/motion-reveal";

const MONDAY_WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SUNDAY_WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const CALENDAR_EVENT_TONES = [
  "border-violet-300/25 bg-violet-500/85 text-white shadow-[0_4px_12px_rgba(139,92,246,.18)]",
  "border-cyan-300/25 bg-cyan-500/80 text-white shadow-[0_4px_12px_rgba(34,211,238,.15)]",
  "border-amber-200/25 bg-amber-400/90 text-slate-950 shadow-[0_4px_12px_rgba(251,191,36,.15)]",
  "border-rose-300/25 bg-rose-500/85 text-white shadow-[0_4px_12px_rgba(244,63,94,.15)]",
  "border-emerald-300/25 bg-emerald-500/85 text-white shadow-[0_4px_12px_rgba(16,185,129,.15)]",
];

function calendarEventTone(status: SocialPost["status"], index: number) {
  if (status === "FAILED") return CALENDAR_EVENT_TONES[3];
  if (status === "PUBLISHED") return CALENDAR_EVENT_TONES[4];
  if (status === "PROCESSING") return CALENDAR_EVENT_TONES[1];
  return CALENDAR_EVENT_TONES[index % CALENDAR_EVENT_TONES.length];
}

function calendarEventLabel(post: SocialPost) {
  const title = post.title?.trim();
  if (title) return title;

  const content = post.content.trim();
  return content ? content.slice(0, 48) : "Untitled post";
}

function calendarDateInputValue(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function CalendarView() {
  const navigate = useNavigate();
  const { interface: interfacePreferences } = useAppearance();
  const weekStartsMonday = interfacePreferences.weekStartsMonday;
  const week = weekStartsMonday ? MONDAY_WEEK : SUNDAY_WEEK;
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
    const firstDayOffset = weekStartsMonday ? (firstDay.getDay() + 6) % 7 : firstDay.getDay();
    const lastDayOffset = weekStartsMonday ? (lastDay.getDay() + 6) % 7 : lastDay.getDay();
    const leadingDays = firstDayOffset;
    const trailingDays = 6 - lastDayOffset;

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
  }, [currentMonth, weekStartsMonday]);

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

  function openNewPostForDate(date: Date) {
    navigate(`/content?scheduleDate=${calendarDateInputValue(date)}`);
  }

  function openPost(post: SocialPost) {
    navigate(`/content?edit=${encodeURIComponent(post.id)}`);
  }

  return (
    <div className="min-h-[100dvh] p-4 sm:p-6">
      <div className="mx-auto max-w-[1440px] space-y-6">
        <PageHeader>
          <PageHeaderContent>
            <PageHeaderTitle>Calendar</PageHeaderTitle>
            <PageHeaderDescription>Scheduled posts.</PageHeaderDescription>
          </PageHeaderContent>
        </PageHeader>

        <ContentWorkspaceNavigation active="calendar" />

        {error ? (
          <div className="rounded-md border border-destructive/30 bg-status-danger-soft px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_360px]">
          <MotionReveal className="min-w-0" delay={0.08}>
            <section className="calendar-surface relative overflow-hidden rounded-2xl border border-primary/25 shadow-[0_18px_48px_rgba(41,14,94,.18)]">
              <div className="relative z-10 p-4 sm:p-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary/80">
                      Publishing calendar
                    </p>
                    <h2 className="mt-2 text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
                      {currentMonth.toLocaleDateString("en-ZA", { month: "long", year: "numeric" })}
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Scheduled posts are rendered by their publish date.
                    </p>
                  </div>

                  <div className="flex items-center gap-2 self-start">
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-primary/25 bg-background/20 hover:bg-primary/10"
                      onClick={() => {
                        const today = new Date();
                        setCurrentMonth(new Date(today.getFullYear(), today.getMonth(), 1));
                      }}
                    >
                      Today
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      className="border-primary/25 bg-background/20 hover:bg-primary/10"
                      aria-label="Previous month"
                      onClick={() =>
                        setCurrentMonth((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1))
                      }
                    >
                      <ArrowLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      className="border-primary/25 bg-background/20 hover:bg-primary/10"
                      aria-label="Next month"
                      onClick={() =>
                        setCurrentMonth((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1))
                      }
                    >
                      <ArrowRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {loading ? (
                  <div className="mt-6 overflow-x-auto pb-1">
                    <div className="min-w-[680px]">
                      <div className="grid grid-cols-7 border-l border-t border-primary/15">
                        {week.map((day) => (
                          <div
                            key={day}
                            className="border-b border-r border-primary/15 px-2 py-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground sm:px-3"
                          >
                            {day}
                          </div>
                        ))}
                        {Array.from({ length: calendarDays.length }).map((_, index) => (
                          <div key={index} className="min-h-[112px] border-b border-r border-primary/15 p-2.5 sm:p-3">
                            <Skeleton className="h-6 w-6 rounded-full bg-primary/10" />
                            <Skeleton className="mt-3 h-7 w-full rounded-md bg-primary/10" />
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="mt-6 overflow-x-auto pb-1">
                    <div className="min-w-[680px]">
                      <div className="grid grid-cols-7 overflow-hidden rounded-xl border-l border-t border-primary/20">
                        {week.map((day) => (
                          <div
                            key={day}
                            className="border-b border-r border-primary/20 bg-background/10 px-2 py-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground sm:px-3"
                          >
                            {day}
                          </div>
                        ))}
                        {calendarDays.map(({ date, inMonth }) => {
                          const items = getPostsForDate(date);
                          const now = new Date();
                          const isToday =
                            date.getFullYear() === now.getFullYear() &&
                            date.getMonth() === now.getMonth() &&
                            date.getDate() === now.getDate();

                          return (
                            <div
                              key={date.toISOString()}
                              role="button"
                              tabIndex={0}
                              aria-label={`Schedule a post for ${date.toLocaleDateString("en-ZA", { weekday: "long", month: "long", day: "numeric" })}`}
                              onClick={() => openNewPostForDate(date)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  openNewPostForDate(date);
                                }
                              }}
                              className={`group min-h-[112px] border-b border-r border-primary/20 p-2.5 transition-colors focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary sm:p-3 ${
                                inMonth ? "bg-background/[0.08] hover:bg-background/[0.14]" : "bg-background/[0.03]"
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span
                                  className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs font-semibold ${
                                    isToday
                                      ? "bg-primary text-primary-foreground shadow-[0_0_0_4px_color-mix(in_srgb,var(--primary)_18%,transparent)]"
                                      : inMonth
                                        ? "text-foreground"
                                        : "text-muted-foreground/50"
                                  }`}
                                >
                                  {date.getDate()}
                                </span>
                                {items.length > 3 ? (
                                  <span className="text-[10px] font-medium text-muted-foreground">+{items.length - 3}</span>
                                ) : null}
                              </div>
                              <div className="mt-2 space-y-1.5">
                                {items.slice(0, 3).map((post, itemIndex) => (
                                  <button
                                    type="button"
                                    key={post.id}
                                    title={`${calendarEventLabel(post)} · ${getPostStatusMeta(post.status).label}`}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      openPost(post);
                                    }}
                                    className={`block w-full truncate rounded-md border px-2 py-1.5 text-left text-[11px] font-medium leading-tight transition-transform hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 ${calendarEventTone(post.status, itemIndex)}`}
                                  >
                                    {calendarEventLabel(post)}
                                  </button>
                                ))}
                                {items.length === 0 && inMonth ? (
                                  <button
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      openNewPostForDate(date);
                                    }}
                                    className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-primary/25 px-2 py-1.5 text-[10px] font-medium text-muted-foreground/80 transition-colors hover:border-primary/50 hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                                  >
                                    <Plus className="h-3 w-3" />
                                    Open slot
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </section>
          </MotionReveal>

          <MotionReveal className="space-y-6" delay={0.16}>
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
          </MotionReveal>
        </div>
      </div>
    </div>
  );
}
