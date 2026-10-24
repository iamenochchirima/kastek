import { PostsWorkspace } from "@/components/social/posts-workspace";

export function meta() { return [{ title: "Create | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

export default function ContentPage() {
  return <PostsWorkspace />;
}
