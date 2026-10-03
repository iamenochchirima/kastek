import { notFound, redirect } from "next/navigation";
import { getWorkspaceSession } from "@/lib/core-auth";
import { fetchCoreJson } from "@/lib/core-server-api";
import { PostDetailPageClient } from "@/components/social/post-detail-page-client";
import type { SocialPost } from "@/components/social/social-shared";

export const metadata = { title: "Post details | KasiTek" };

export default async function ContentPostDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getWorkspaceSession();
  if (!session?.user?.id) redirect("/login");

  const { id } = await params;
  const response = await fetchCoreJson<{ post?: SocialPost }>(
    `/api/social/posts/${encodeURIComponent(id)}`,
  ).catch(() => null);

  if (!response?.post) notFound();

  return <PostDetailPageClient initialPost={response.post} />;
}
