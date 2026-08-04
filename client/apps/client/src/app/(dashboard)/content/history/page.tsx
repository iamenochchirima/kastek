import { PostsWorkspace } from "@/components/social/posts-workspace";

export const metadata = { title: "Post history | KasiTek" };

export default function ContentHistoryPage() {
  return <PostsWorkspace view="history" />;
}
