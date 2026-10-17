import { redirect } from "@/lib/navigation";

export default async function CreateGeneralAgentPage() {
  redirect("/app/agents/new");
}
