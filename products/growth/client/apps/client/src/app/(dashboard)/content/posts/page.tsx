import { PostsWorkspace } from "@/components/social/posts-workspace";

export const metadata = { title: "Posts | KasiTek" };

export default function ContentPostsPage() {
  return <PostsWorkspace view="history" />;
}
