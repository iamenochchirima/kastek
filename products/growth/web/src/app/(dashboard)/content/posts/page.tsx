import { PostsWorkspace } from "@/components/social/posts-workspace";

export function meta() { return [{ title: "Posts | KasiTek" }]; }

export default function ContentPostsPage() {
  return <PostsWorkspace view="history" />;
}
