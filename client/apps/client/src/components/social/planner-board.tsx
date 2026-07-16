"use client";

import { apiUrl } from "@/lib/server-api";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { type SocialPost, groupPostsByStatus } from "@/components/social/social-shared";

export function PlannerBoard() {
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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
        throw new Error(payload.error || "Failed to load planner");
      }

      setPosts(payload.posts || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load planner");
    } finally {
      setLoading(false);
    }
  }

  const grouped = useMemo(() => groupPostsByStatus(posts), [posts]);
  const lanes = [
    { title: "Ideas", items: grouped.ideas.map((post) => post.prompt || post.title || "Untitled idea") },
    { title: "Drafting", items: grouped.drafting.map((post) => post.title || post.content.slice(0, 60)) },
    { title: "Approved", items: grouped.approved.map((post) => post.title || post.content.slice(0, 60)) },
    { title: "Published", items: grouped.published.map((post) => post.title || post.content.slice(0, 60)) },
  ];

  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <div>
          <Badge className="mb-2 border-primary/30 bg-primary/5 text-primary">Planner</Badge>
          <h1 className="text-3xl font-semibold tracking-tight">Move ideas into scheduled content.</h1>
          <p className="mt-1 text-muted-foreground">
            This board now reflects your real social post records grouped by their current workflow state.
          </p>
        </div>

        {error ? (
          <div className="rounded-md border border-destructive/30 bg-status-danger-soft px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-4">
          {lanes.map((lane) => (
            <Card key={lane.title}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  <span>{lane.title}</span>
                  <span className="text-sm text-muted-foreground">{lane.items.length}</span>
                </CardTitle>
                <CardDescription>
                  {lane.title === "Ideas"
                    ? "Raw prompts and content concepts"
                    : lane.title === "Drafting"
                      ? "Posts still being shaped"
                      : lane.title === "Approved"
                        ? "Scheduled and ready for publish jobs"
                        : "Already pushed through the pipeline"}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {loading ? (
                  <div className="space-y-3">
                    {Array.from({ length: 4 }).map((_, index) => (
                      <Skeleton key={index} className="h-14 w-full rounded-md" />
                    ))}
                  </div>
                ) : lane.items.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
                    Nothing in this lane yet.
                  </div>
                ) : (
                  lane.items.map((item) => (
                    <div key={item} className="rounded-md bg-secondary/50 p-4 text-sm text-foreground">
                      {item}
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
