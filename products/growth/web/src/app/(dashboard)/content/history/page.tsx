import { redirect } from "react-router";

export function clientLoader() {
  throw redirect("/content/posts");
}

export default function ContentHistoryPage() { return null; }

export function meta() { return [{ name: "robots", content: "noindex, nofollow" }]; }
