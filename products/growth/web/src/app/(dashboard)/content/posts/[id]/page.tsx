import { useLoaderData, type ClientLoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { getWorkspaceSession } from "@/lib/core-auth";
import { fetchCoreJson } from "@/lib/core-server-api";
import { PostDetailPageClient } from "@/components/social/post-detail-page-client";
import type { SocialPost } from "@/components/social/social-shared";

export function meta() { return [{ title: "Post details | KasiTek" }]; }

export async function clientLoader(route: ClientLoaderFunctionArgs) {
  const params = (route.params as { id: string });

  const session = await getWorkspaceSession();
  if (!session?.user?.id) throw redirect("/login");

  const { id } = params;
  const response = await fetchCoreJson<{ post?: SocialPost }>(
    `/api/social/posts/${encodeURIComponent(id)}`,
  ).catch(() => null);

  if (!response?.post) throw new Response("Not found", { status: 404 });

  return { post: response.post };
}

export default function ContentPostDetailPage() {
  const { post } = useLoaderData<typeof clientLoader>();
  return <PostDetailPageClient initialPost={post} />;
}
