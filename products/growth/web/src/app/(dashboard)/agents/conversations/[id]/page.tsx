import { useLoaderData, type ClientLoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { getWorkspaceSession } from "@/lib/core-auth";
import { GrowthConversationPage } from "@/components/dashboard/agents/conversation-page";

export function meta() { return [{ title: "Agent conversation | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }
export async function clientLoader(route: ClientLoaderFunctionArgs) {
  const params = (route.params as { id: string });
  const search = new URL(route.request.url).searchParams;
  const searchParams = (Object.fromEntries([...search.keys()].map(key => [key, search.getAll(key).length > 1 ? search.getAll(key) : search.get(key)!])) as { task?: string });

  if (!await getWorkspaceSession(route.request)) throw redirect("/login");
  const { id } = params;
  const { task } = searchParams;
  return { id, task };
}

export default function ConversationPage() {
  const { id, task } = useLoaderData<typeof clientLoader>();
  return <GrowthConversationPage conversationId={id} taskId={task} />;
}
